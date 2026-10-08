//! 凭据存储（M2-02）：用内存实现代替系统凭据管理器，检查保存规则、状态不含密钥，以及代理按保存的绑定注入凭据。

use std::sync::Arc;

use fudiao_lib::credentials::{
    CredentialError, CredentialStatus, MemoryStore, SecretStore, StoredCredentials,
};
use fudiao_lib::net::{Auth, Credentials, KeyHeader, NetError};

const SECRET: &str = "sk-real-secret";

/// 测试中需要直接查看凭据管理器里的内容。
#[derive(Default, Clone)]
struct Shared(Arc<MemoryStore>);

impl SecretStore for Shared {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.0.get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.delete(account)
    }
}

fn setup() -> (Arc<StoredCredentials>, Shared) {
    let store = Shared::default();
    (StoredCredentials::new(Box::new(store.clone())), store)
}

#[test]
fn saves_the_key_bound_to_the_origin_and_never_reports_it() {
    let (credentials, store) = setup();
    let status = credentials
        .set(
            "p1",
            "https://api.anthropic.com/v1",
            Some(KeyHeader::XApiKey),
            Some(format!("  {SECRET}\n")),
        )
        .unwrap();
    assert_eq!(
        status,
        CredentialStatus {
            stored: true,
            origin: Some("https://api.anthropic.com".into()),
            has_secret: true
        }
    );
    // 状态序列化后给界面，不含密钥。
    assert!(!serde_json::to_string(&credentials.status("p1").unwrap())
        .unwrap()
        .contains(SECRET));
    // 首尾空白去掉后保存。
    let binding = credentials.binding("p1").unwrap();
    assert_eq!(binding.origin, "https://api.anthropic.com");
    assert_eq!(
        binding.auth,
        Auth::ApiKey {
            header: KeyHeader::XApiKey,
            secret: SECRET.into()
        }
    );
    assert!(store
        .get("p1")
        .unwrap()
        .unwrap()
        .contains("https://api.anthropic.com"));
}

#[test]
fn rejects_insecure_or_incomplete_settings() {
    let (credentials, _) = setup();
    assert_eq!(
        credentials
            .set(
                "p1",
                "http://api.example.test/v1",
                Some(KeyHeader::Bearer),
                Some(SECRET.into())
            )
            .err(),
        Some(CredentialError::Invalid {
            reason: NetError::InsecureScheme
        })
    );
    assert_eq!(
        credentials
            .set(
                "p1",
                "https://api.example.test/v1",
                Some(KeyHeader::Bearer),
                Some("  ".into())
            )
            .err(),
        Some(CredentialError::MissingSecret)
    );
    // 不需要密钥的只能是本地端点。
    assert!(matches!(
        credentials
            .set("p1", "https://api.example.test/v1", None, None)
            .err(),
        Some(CredentialError::Invalid {
            reason: NetError::HostNotAllowed { .. }
        })
    ));
    let local = credentials
        .set("p2", "http://127.0.0.1:11434/v1", None, Some(SECRET.into()))
        .unwrap();
    assert_eq!(
        local,
        CredentialStatus {
            stored: true,
            origin: Some("http://127.0.0.1:11434".into()),
            has_secret: false
        }
    );
    assert_eq!(credentials.binding("p2").unwrap().auth, Auth::None);
    assert!(!credentials.status("p1").unwrap().stored);
}

#[test]
fn replacing_the_address_requires_the_key_again_and_delete_removes_it() {
    let (credentials, _) = setup();
    credentials
        .set(
            "p1",
            "https://a.example.test",
            Some(KeyHeader::Bearer),
            Some(SECRET.into()),
        )
        .unwrap();
    // 换地址就是重新保存：必须同时给出密钥。
    assert_eq!(
        credentials
            .set(
                "p1",
                "https://b.example.test",
                Some(KeyHeader::Bearer),
                None
            )
            .err(),
        Some(CredentialError::MissingSecret)
    );
    assert_eq!(
        credentials.binding("p1").unwrap().origin,
        "https://a.example.test"
    );
    credentials.delete("p1").unwrap();
    assert!(credentials.binding("p1").is_none());
    assert_eq!(
        credentials.status("p1").unwrap(),
        CredentialStatus {
            stored: false,
            origin: None,
            has_secret: false
        }
    );
    // 删除不存在的条目不报错。
    credentials.delete("p1").unwrap();
}

#[test]
fn damaged_or_loosened_entries_are_ignored() {
    let (credentials, store) = setup();
    store.set("p1", "不是 JSON").unwrap();
    assert!(credentials.binding("p1").is_none());
    // 被改成明文 http 的条目不会放宽限制。
    store
        .set("p2", &format!(r#"{{"v":1,"origin":"http://api.example.test","header":"bearer","secret":"{SECRET}"}}"#))
        .unwrap();
    assert!(credentials.binding("p2").is_none());
}
