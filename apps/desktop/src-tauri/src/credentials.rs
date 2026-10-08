//! 凭据存储（施工文档第五章，M2-02）：API Key 只保存在系统凭据管理器，只在 Rust 中使用，从不返回给 WebView。
//!
//! 每个模型服务一条：凭据管理器中的目标名为 `com.fudiao.desktop` 加服务标识，内容是 JSON，含绑定的源、认证头写法与密钥。
//! 源与密钥一起保存、一起取出：界面不能单独改写绑定的地址，更改服务地址须重新填写 API Key（凭据代理据此只把凭据发往这个源）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::net::{Auth, Binding, Credentials, KeyHeader, NetError, DEFAULT_CONCURRENCY};

/// 保存密文的地方。正式实现是系统凭据管理器，测试用内存实现。
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub const SERVICE: &str = "com.fudiao.desktop";

/// Windows 凭据管理器（keyring crate）。
pub struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// 内存实现，供测试使用。
#[derive(Default)]
pub struct MemoryStore(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

/// 凭据管理器中保存的内容。
#[derive(Serialize, Deserialize)]
struct Stored {
    v: u32,
    origin: String,
    header: Option<KeyHeader>,
    secret: Option<String>,
}

/// 给界面看的状态：有没有保存、绑定在哪个源，不含密钥。
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub stored: bool,
    pub origin: Option<String>,
    pub has_secret: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum CredentialError {
    /// 地址或凭据不符合要求（见 `NetError`）。
    Invalid { reason: NetError },
    /// 需要凭据的服务没有填写 API Key，或填写了认证头写法以外的组合。
    MissingSecret,
    /// 系统凭据管理器读写失败。
    Store { detail: String },
}

pub struct StoredCredentials {
    store: Box<dyn SecretStore>,
}

impl StoredCredentials {
    pub fn new(store: Box<dyn SecretStore>) -> Arc<StoredCredentials> {
        Arc::new(StoredCredentials { store })
    }

    /// 保存（或替换）一个服务的凭据。`header` 为 None 表示本地端点，不需要密钥，地址只能是回环地址。
    pub fn set(
        &self,
        provider_id: &str,
        base_url: &str,
        header: Option<KeyHeader>,
        secret: Option<String>,
    ) -> Result<CredentialStatus, CredentialError> {
        let auth = match (header, secret) {
            (None, _) => Auth::None,
            (Some(header), Some(secret)) if !secret.trim().is_empty() => Auth::ApiKey {
                header,
                secret: secret.trim().to_string(),
            },
            (Some(_), _) => return Err(CredentialError::MissingSecret),
        };
        let binding = Binding::new(base_url, auth, DEFAULT_CONCURRENCY)
            .map_err(|reason| CredentialError::Invalid { reason })?;
        let (header, secret) = match binding.auth {
            Auth::None => (None, None),
            Auth::ApiKey { header, secret } => (Some(header), Some(secret)),
        };
        let stored = Stored {
            v: 1,
            origin: binding.origin,
            header,
            secret,
        };
        let json = serde_json::to_string(&stored).expect("凭据内容总能序列化");
        self.store
            .set(provider_id, &json)
            .map_err(|detail| CredentialError::Store { detail })?;
        Ok(CredentialStatus {
            stored: true,
            origin: Some(stored.origin),
            has_secret: stored.secret.is_some(),
        })
    }

    pub fn status(&self, provider_id: &str) -> Result<CredentialStatus, CredentialError> {
        Ok(match self.read(provider_id)? {
            Some(s) => CredentialStatus {
                stored: true,
                origin: Some(s.origin),
                has_secret: s.secret.is_some(),
            },
            None => CredentialStatus {
                stored: false,
                origin: None,
                has_secret: false,
            },
        })
    }

    pub fn delete(&self, provider_id: &str) -> Result<(), CredentialError> {
        self.store
            .delete(provider_id)
            .map_err(|detail| CredentialError::Store { detail })
    }

    fn read(&self, provider_id: &str) -> Result<Option<Stored>, CredentialError> {
        let value = self
            .store
            .get(provider_id)
            .map_err(|detail| CredentialError::Store { detail })?;
        // 内容无法解析（例如被别的程序改过）时视为没有凭据，作者重新填写即可。
        Ok(value.and_then(|v| serde_json::from_str::<Stored>(&v).ok()))
    }
}

impl Credentials for StoredCredentials {
    fn binding(&self, provider_id: &str) -> Option<Binding> {
        let stored = self.read(provider_id).ok().flatten()?;
        let auth = match (stored.header, stored.secret) {
            (Some(header), Some(secret)) => Auth::ApiKey { header, secret },
            (None, None) => Auth::None,
            _ => return None,
        };
        // 读出时再按同样的规则校验一次，凭据管理器中的内容被改动也不会放宽限制。
        let binding = Binding::new(&stored.origin, auth, DEFAULT_CONCURRENCY).ok()?;
        (binding.origin == stored.origin).then_some(binding)
    }
}

/// 凭据命令所用的状态，与凭据代理共用同一个凭据来源。
pub struct CredentialState {
    pub credentials: Arc<StoredCredentials>,
}

#[tauri::command]
pub async fn credential_set(
    state: tauri::State<'_, CredentialState>,
    provider_id: String,
    base_url: String,
    key_header: Option<KeyHeader>,
    secret: Option<String>,
) -> Result<CredentialStatus, CredentialError> {
    let credentials = state.credentials.clone();
    // 凭据管理器的调用是阻塞的。
    tauri::async_runtime::spawn_blocking(move || {
        credentials.set(&provider_id, &base_url, key_header, secret)
    })
    .await
    .map_err(|e| CredentialError::Store {
        detail: e.to_string(),
    })?
}

#[tauri::command]
pub async fn credential_status(
    state: tauri::State<'_, CredentialState>,
    provider_id: String,
) -> Result<CredentialStatus, CredentialError> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.status(&provider_id))
        .await
        .map_err(|e| CredentialError::Store {
            detail: e.to_string(),
        })?
}

#[tauri::command]
pub async fn credential_delete(
    state: tauri::State<'_, CredentialState>,
    provider_id: String,
) -> Result<(), CredentialError> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.delete(&provider_id))
        .await
        .map_err(|e| CredentialError::Store {
            detail: e.to_string(),
        })?
}
