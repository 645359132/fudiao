//! 凭据代理（施工文档第五章“模型接入”）：发往模型服务的请求经这里转发，WebView 拿不到 API Key。
//!
//! - 凭据与源（协议、主机、端口）绑定，只附加到这个源；请求的目标不是这个源时拒绝，一个字节也不发。
//! - 需要凭据的服务必须是 https；本地端点（不需要凭据）只允许回环地址，代理不能被当作任意地址的 fetch。
//! - 不跟随重定向：自定义的认证头（`x-api-key`）在跨主机重定向时不会被去掉，3xx 原样交给 SDK。
//! - 不重试（由 SDK 负责）；按源限制并发；可取消，取消前已收到的内容照常交给适配器。
//! - 不记录请求头与正文；错误说明中去掉 URL。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, Semaphore};
use url::{Host, Url};

/// 认证头的写法：Anthropic 用 `x-api-key`，OpenAI 及其兼容接口（含 Gemini 兼容模式）用 `Authorization: Bearer`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyHeader {
    XApiKey,
    Bearer,
}

#[derive(Clone, PartialEq, Eq)]
pub enum Auth {
    /// 本地端点，不需要凭据。
    None,
    ApiKey {
        header: KeyHeader,
        secret: String,
    },
}

impl std::fmt::Debug for Auth {
    // 不让密钥出现在调试输出与日志中。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Auth::None => write!(f, "None"),
            Auth::ApiKey { header, .. } => write!(f, "ApiKey({header:?}, ***)"),
        }
    }
}

/// 一个模型服务的凭据与它绑定的源。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    /// 规范化的源，例如 `https://api.anthropic.com`。
    pub origin: String,
    pub auth: Auth,
    /// 同一个源同时进行的请求数上限。
    pub concurrency: usize,
}

pub const DEFAULT_CONCURRENCY: usize = 4;

impl Binding {
    /// 由服务的地址（base URL）建立绑定，并检查协议与主机。
    pub fn new(base_url: &str, auth: Auth, concurrency: usize) -> Result<Binding, NetError> {
        let url = Url::parse(base_url).map_err(|_| NetError::InvalidRequest {
            detail: "服务地址无效".into(),
        })?;
        let loopback = is_loopback(&url);
        // 不需要凭据的本地端点先查主机：局域网的 http 地址应提示“只能是本机”，而不是“须用 https”。
        if auth == Auth::None && !loopback {
            return Err(NetError::HostNotAllowed {
                origin: origin_of(&url),
            });
        }
        match url.scheme() {
            "https" => {}
            "http" if loopback => {}
            _ => return Err(NetError::InsecureScheme),
        }
        Ok(Binding {
            origin: origin_of(&url),
            auth,
            concurrency: concurrency.max(1),
        })
    }
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// 凭据来源。M2-02 由系统凭据管理器提供；测试用内存实现。
pub trait Credentials: Send + Sync {
    fn binding(&self, provider_id: &str) -> Option<Binding>;
}

#[derive(Default)]
pub struct MemoryCredentials {
    map: Mutex<HashMap<String, Binding>>,
}

impl MemoryCredentials {
    pub fn set(&self, provider_id: &str, binding: Binding) {
        self.map
            .lock()
            .unwrap()
            .insert(provider_id.to_string(), binding);
    }

    pub fn remove(&self, provider_id: &str) {
        self.map.lock().unwrap().remove(provider_id);
    }
}

impl Credentials for MemoryCredentials {
    fn binding(&self, provider_id: &str) -> Option<Binding> {
        self.map.lock().unwrap().get(provider_id).cloned()
    }
}

/// 界面发来的请求。`id` 由界面生成，用于取消。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRequest {
    pub id: String,
    pub provider_id: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// 经 Channel 回传的事件：先是响应头，然后是若干块响应体，最后是结束或失败。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum NetEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End {
        cancelled: bool,
    },
    Failed {
        message: String,
    },
}

/// 请求发出之前的拒绝。
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum NetError {
    /// 没有这个服务的凭据或绑定。
    UnknownProvider,
    /// 请求的目标不是该服务绑定的源。
    HostNotAllowed {
        origin: String,
    },
    /// 需要凭据的服务必须使用 https（回环地址除外）。
    InsecureScheme,
    InvalidRequest {
        detail: String,
    },
    /// 同一标识的请求仍在进行。
    DuplicateId,
}

/// 由界面带来、会被代理替换或不允许界面指定的请求头。
const DROPPED_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "cookie",
    "proxy-authorization",
];

pub struct Prepared {
    id: String,
    origin: String,
    concurrency: usize,
    request: reqwest::Request,
    cancel: Arc<Notify>,
}

pub struct Proxy {
    client: reqwest::Client,
    credentials: Arc<dyn Credentials>,
    /// 每个源的并发上限与信号量；上限改变时换一个新的信号量（进行中的请求在旧信号量上照常完成）。
    limits: Mutex<HashMap<String, (usize, Arc<Semaphore>)>>,
    /// 服务设置中的并发上限（`net_set_limits`），没有设置时用绑定中的默认值。
    overrides: Mutex<HashMap<String, usize>>,
    inflight: Mutex<HashMap<String, Arc<Notify>>>,
}

impl Proxy {
    pub fn new(credentials: Arc<dyn Credentials>) -> Proxy {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(30))
            .build()
            .expect("无法建立 HTTP 客户端");
        Proxy {
            client,
            credentials,
            limits: Mutex::new(HashMap::new()),
            overrides: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    /// 设置各服务的并发上限（来自应用设置中的服务配置；不涉及凭据，界面可以随时设置）。
    pub fn set_limits(&self, limits: &[(String, usize)]) {
        let mut overrides = self.overrides.lock().unwrap();
        overrides.clear();
        for (provider_id, limit) in limits {
            overrides.insert(provider_id.clone(), (*limit).max(1));
        }
    }

    /// 校验并组装请求：服务存在、目标是绑定的源、注入凭据。校验不通过时不发出任何请求。
    pub fn prepare(&self, req: NetRequest) -> Result<Prepared, NetError> {
        let binding = self
            .credentials
            .binding(&req.provider_id)
            .ok_or(NetError::UnknownProvider)?;
        let url = Url::parse(&req.url).map_err(|_| NetError::InvalidRequest {
            detail: "请求地址无效".into(),
        })?;
        let origin = origin_of(&url);
        if origin != binding.origin {
            return Err(NetError::HostNotAllowed { origin });
        }
        if url.scheme() != "https" && !is_loopback(&url) {
            return Err(NetError::InsecureScheme);
        }
        let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|_| {
            NetError::InvalidRequest {
                detail: "请求方法无效".into(),
            }
        })?;

        let mut builder = self.client.request(method, url);
        for (name, value) in &req.headers {
            if DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            builder = builder.header(name, value);
        }
        builder = match &binding.auth {
            Auth::None => builder,
            Auth::ApiKey {
                header: KeyHeader::XApiKey,
                secret,
            } => builder.header("x-api-key", secret),
            Auth::ApiKey {
                header: KeyHeader::Bearer,
                secret,
            } => builder.header("authorization", format!("Bearer {secret}")),
        };
        if let Some(body) = req.body {
            builder = builder.body(body);
        }
        let request = builder.build().map_err(|_| NetError::InvalidRequest {
            detail: "请求头无效".into(),
        })?;

        let cancel = Arc::new(Notify::new());
        {
            let mut inflight = self.inflight.lock().unwrap();
            if inflight.contains_key(&req.id) {
                return Err(NetError::DuplicateId);
            }
            inflight.insert(req.id.clone(), cancel.clone());
        }
        Ok(Prepared {
            id: req.id,
            origin,
            concurrency: self
                .overrides
                .lock()
                .unwrap()
                .get(&req.provider_id)
                .copied()
                .unwrap_or(binding.concurrency),
            request,
            cancel,
        })
    }

    fn semaphore(&self, origin: &str, concurrency: usize) -> Arc<Semaphore> {
        let mut limits = self.limits.lock().unwrap();
        match limits.get(origin) {
            Some((limit, semaphore)) if *limit == concurrency => semaphore.clone(),
            _ => {
                let semaphore = Arc::new(Semaphore::new(concurrency));
                limits.insert(origin.to_string(), (concurrency, semaphore.clone()));
                semaphore
            }
        }
    }

    /// 发出请求并经 `emit` 回传事件，直到结束、失败或取消。
    pub async fn run(&self, prepared: Prepared, mut emit: impl FnMut(NetEvent) + Send) {
        let Prepared {
            id,
            origin,
            concurrency,
            request,
            cancel,
        } = prepared;
        let semaphore = self.semaphore(&origin, concurrency);
        let event = tokio::select! {
            _ = cancel.notified() => Some(NetEvent::End { cancelled: true }),
            permit = semaphore.acquire_owned() => {
                let _permit = permit.expect("信号量不会关闭");
                self.forward(request, &cancel, &mut emit).await
            }
        };
        if let Some(event) = event {
            emit(event);
        }
        self.inflight.lock().unwrap().remove(&id);
    }

    /// 转发并流式回传；返回最后一个事件。
    async fn forward(
        &self,
        request: reqwest::Request,
        cancel: &Notify,
        emit: &mut (impl FnMut(NetEvent) + Send),
    ) -> Option<NetEvent> {
        let response = tokio::select! {
            _ = cancel.notified() => return Some(NetEvent::End { cancelled: true }),
            r = self.client.execute(request) => r,
        };
        let response = match response {
            Ok(r) => r,
            Err(e) => {
                return Some(NetEvent::Failed {
                    message: e.without_url().to_string(),
                })
            }
        };
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| name.as_str() != "set-cookie")
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_string(), v.to_string()))
            })
            .collect();
        emit(NetEvent::Head {
            status: response.status().as_u16(),
            headers,
        });
        let mut body = response.bytes_stream();
        loop {
            tokio::select! {
                _ = cancel.notified() => return Some(NetEvent::End { cancelled: true }),
                chunk = body.next() => match chunk {
                    Some(Ok(bytes)) => emit(NetEvent::Chunk { data: bytes.to_vec() }),
                    Some(Err(e)) => return Some(NetEvent::Failed { message: e.without_url().to_string() }),
                    None => return Some(NetEvent::End { cancelled: false }),
                },
            }
        }
    }

    /// 取消一个请求；返回是否找到。取消在请求开始前到达时同样生效。
    pub fn cancel(&self, id: &str) -> bool {
        match self.inflight.lock().unwrap().get(id) {
            Some(cancel) => {
                cancel.notify_one();
                true
            }
            None => false,
        }
    }
}

/// 应用中的代理，凭据来自系统凭据管理器（`credentials.rs`）。
pub struct NetState {
    pub proxy: Arc<Proxy>,
}

#[tauri::command]
pub async fn net_fetch(
    state: tauri::State<'_, NetState>,
    request: NetRequest,
    channel: tauri::ipc::Channel<NetEvent>,
) -> Result<(), NetError> {
    let prepared = state.proxy.prepare(request)?;
    let proxy = state.proxy.clone();
    tauri::async_runtime::spawn(async move {
        proxy
            .run(prepared, move |event| {
                // 界面已关闭时发送失败，忽略即可。
                let _ = channel.send(event);
            })
            .await;
    });
    Ok(())
}

#[tauri::command]
pub fn net_cancel(state: tauri::State<'_, NetState>, id: String) -> bool {
    state.proxy.cancel(&id)
}

#[tauri::command]
pub fn net_set_limits(state: tauri::State<'_, NetState>, limits: Vec<(String, usize)>) {
    state.proxy.set_limits(&limits);
}
