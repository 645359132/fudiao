//! 凭据代理（施工文档第五章“模型接入”）：发往模型服务的请求经这里转发，WebView 拿不到 API Key。
//!
//! - 凭据与源（协议、主机、端口）绑定，只附加到这个源；请求的目标不是这个源时拒绝，一个字节也不发。
//! - 需要凭据的服务必须是 https；本地端点（不需要凭据）只允许回环地址，代理不能被当作任意地址的 fetch。
//! - 不跟随重定向：自定义的认证头（`x-api-key`）在跨主机重定向时不会被去掉，3xx 原样交给 SDK。
//! - 回环地址的请求不经系统代理与 HTTP_PROXY，不会被转发出本机。
//! - 不重试（由 SDK 负责）；按源限制并发；可取消（先于开始到达的取消也生效），取消前已收到的内容照常交给适配器。
//! - 不记录请求头与正文；错误说明中去掉 URL；错误响应中回显的密钥换成 `***`。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use url::{Host, Url};

/// 认证头的写法：Anthropic 用 `x-api-key`，OpenAI 及其兼容接口（含 Gemini 兼容模式）用 `Authorization: Bearer`，
/// Brave Search（B84 的搜索服务）用 `X-Subscription-Token`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyHeader {
    XApiKey,
    Bearer,
    XSubscriptionToken,
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
/// 与服务设置的取值范围（packages/store/src/app/model-services.ts，1 到 64）一致；信号量的名额也不能过大。
pub const MAX_CONCURRENCY: usize = 64;

fn clamp_concurrency(n: usize) -> usize {
    n.clamp(1, MAX_CONCURRENCY)
}

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
            concurrency: clamp_concurrency(concurrency),
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
    "x-subscription-token",
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
    loopback: bool,
    /// 用于从错误响应中去掉回显的密钥；不需要凭据的服务为 None。
    secret: Option<String>,
}

impl Prepared {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// 错误响应（4xx、5xx）的响应体最多读这么多，去掉密钥后整块交给界面。
const MAX_ERROR_BODY: usize = 1024 * 1024;
/// 开始前到达的取消保留多久、最多几条（请求结束后才到的取消也会记在这里，不能无限增长）。
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(60);
const EARLY_CANCEL_MAX: usize = 1024;

#[derive(Default)]
struct Inflight {
    running: HashMap<String, Arc<Notify>>,
    /// 在 `prepare` 之前到达的取消。界面的取消与 `net_fetch` 是两次独立的调用，到达顺序没有保证。
    cancelled_early: HashMap<String, Instant>,
}

/// 一个源的并发名额。上限改变时就地增减名额，不换信号量：换了之后旧信号量上的请求不再计数，
/// 同源不同上限的服务交替请求时上限形同虚设。名额一时收不回来的记为欠额，请求结束时抵掉。
struct Limiter {
    limit: usize,
    semaphore: Arc<Semaphore>,
    debt: Arc<AtomicUsize>,
}

impl Limiter {
    fn new(limit: usize) -> Limiter {
        Limiter {
            limit,
            semaphore: Arc::new(Semaphore::new(limit)),
            debt: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn resize(&mut self, limit: usize) {
        if limit > self.limit {
            let more = limit - self.limit;
            // 先用新增的名额抵掉欠额，余下的才真正放出去。
            let paid = take_debt(&self.debt, more);
            self.semaphore.add_permits(more - paid);
        } else if limit < self.limit {
            let fewer = self.limit - limit;
            let forgotten = self.semaphore.forget_permits(fewer);
            self.debt.fetch_add(fewer - forgotten, Ordering::SeqCst);
        }
        self.limit = limit;
    }
}

/// 原子地从欠额里扣掉最多 up_to，返回实际扣掉的数（欠额不够时扣到 0）。
/// 不用 fetch_update：Rust 1.99 起它改名 try_update，旧名字带弃用警告，新名字又超出本仓库声明的最低版本。
fn take_debt(debt: &AtomicUsize, up_to: usize) -> usize {
    let mut current = debt.load(Ordering::SeqCst);
    loop {
        let taken = current.min(up_to);
        match debt.compare_exchange(current, current - taken, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return taken,
            Err(actual) => current = actual,
        }
    }
}

/// 请求占用的名额；有欠额时结束后不归还。
struct Slot {
    permit: Option<OwnedSemaphorePermit>,
    debt: Arc<AtomicUsize>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            if take_debt(&self.debt, 1) == 1 {
                permit.forget();
            }
        }
    }
}

pub struct Proxy {
    /// 发往 https 服务，照常使用系统代理设置。
    client: reqwest::Client,
    /// 发往回环地址，不经任何代理：系统代理或 HTTP_PROXY 会把带凭据与正文的请求转发出本机。
    local: reqwest::Client,
    credentials: Arc<dyn Credentials>,
    limits: Mutex<HashMap<String, Limiter>>,
    /// 服务设置中的并发上限（`net_set_limits`），没有设置时用绑定中的默认值。
    overrides: Mutex<HashMap<String, usize>>,
    inflight: Mutex<Inflight>,
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
}

/// 把密钥原文换成 `***`。中转站可能在错误说明里回显请求头，原样转发会写进调用记录与导出。
fn redact(bytes: &[u8], secret: &str) -> Vec<u8> {
    let needle = secret.as_bytes();
    if needle.is_empty() {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(needle) {
            out.extend_from_slice(b"***");
            i += needle.len();
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

impl Proxy {
    pub fn new(credentials: Arc<dyn Credentials>) -> Proxy {
        Proxy {
            client: client_builder().build().expect("无法建立 HTTP 客户端"),
            local: client_builder()
                .no_proxy()
                .build()
                .expect("无法建立 HTTP 客户端"),
            credentials,
            limits: Mutex::new(HashMap::new()),
            overrides: Mutex::new(HashMap::new()),
            inflight: Mutex::new(Inflight::default()),
        }
    }

    /// 设置各服务的并发上限（来自应用设置中的服务配置；不涉及凭据，界面可以随时设置）。
    pub fn set_limits(&self, limits: &[(String, usize)]) {
        let mut overrides = self.overrides.lock().unwrap();
        overrides.clear();
        for (provider_id, limit) in limits {
            overrides.insert(provider_id.clone(), clamp_concurrency(*limit));
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
        let loopback = is_loopback(&url);
        if url.scheme() != "https" && !loopback {
            return Err(NetError::InsecureScheme);
        }
        let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|_| {
            NetError::InvalidRequest {
                detail: "请求方法无效".into(),
            }
        })?;

        let client = if loopback { &self.local } else { &self.client };
        let mut builder = client.request(method, url);
        for (name, value) in &req.headers {
            if DROPPED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            builder = builder.header(name, value);
        }
        let secret = match &binding.auth {
            Auth::None => None,
            Auth::ApiKey { header, secret } => {
                builder = match header {
                    KeyHeader::XApiKey => builder.header("x-api-key", secret),
                    KeyHeader::Bearer => {
                        builder.header("authorization", format!("Bearer {secret}"))
                    }
                    KeyHeader::XSubscriptionToken => builder.header("x-subscription-token", secret),
                };
                Some(secret.clone())
            }
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
            if inflight.running.contains_key(&req.id) {
                return Err(NetError::DuplicateId);
            }
            if inflight.cancelled_early.remove(&req.id).is_some() {
                // Notify 会存下这个许可：`run` 一开始就选中取消，不发出请求。
                cancel.notify_one();
            }
            inflight.running.insert(req.id.clone(), cancel.clone());
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
            loopback,
            secret,
        })
    }

    fn limiter(&self, origin: &str, concurrency: usize) -> (Arc<Semaphore>, Arc<AtomicUsize>) {
        let mut limits = self.limits.lock().unwrap();
        let limiter = limits
            .entry(origin.to_string())
            .or_insert_with(|| Limiter::new(concurrency));
        if limiter.limit != concurrency {
            limiter.resize(concurrency);
        }
        (limiter.semaphore.clone(), limiter.debt.clone())
    }

    /// 发出请求并经 `emit` 回传事件，直到结束、失败或取消。
    pub async fn run(&self, prepared: Prepared, mut emit: impl FnMut(NetEvent) + Send) {
        let Prepared {
            id,
            origin,
            concurrency,
            request,
            cancel,
            loopback,
            secret,
        } = prepared;
        let (semaphore, debt) = self.limiter(&origin, concurrency);
        let client = if loopback { &self.local } else { &self.client };
        // 三处 select 都先看取消（biased）：开始前已到的取消与可以发送同时就绪时，随机选择会把请求连同凭据发出去。
        let event = tokio::select! {
            biased;
            _ = cancel.notified() => Some(NetEvent::End { cancelled: true }),
            permit = semaphore.acquire_owned() => {
                let _slot = Slot { permit: Some(permit.expect("信号量不会关闭")), debt };
                forward(client, request, &cancel, secret.as_deref(), &mut emit).await
            }
        };
        if let Some(event) = event {
            emit(event);
        }
        self.inflight.lock().unwrap().running.remove(&id);
    }

    /// 取消一个请求；返回它是否正在进行。还没开始的请求记下来，开始时直接结束，不发出。
    pub fn cancel(&self, id: &str) -> bool {
        let mut inflight = self.inflight.lock().unwrap();
        if let Some(cancel) = inflight.running.get(id) {
            cancel.notify_one();
            return true;
        }
        let now = Instant::now();
        let early = &mut inflight.cancelled_early;
        early.retain(|_, at| now.duration_since(*at) < EARLY_CANCEL_TTL);
        if early.len() >= EARLY_CANCEL_MAX {
            if let Some(oldest) = early
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(k, _)| k.clone())
            {
                early.remove(&oldest);
            }
        }
        early.insert(id.to_string(), now);
        false
    }

    #[cfg(test)]
    fn early_cancels(&self) -> usize {
        self.inflight.lock().unwrap().cancelled_early.len()
    }
}

/// 转发并流式回传；返回最后一个事件。
async fn forward(
    client: &reqwest::Client,
    request: reqwest::Request,
    cancel: &Notify,
    secret: Option<&str>,
    emit: &mut (impl FnMut(NetEvent) + Send),
) -> Option<NetEvent> {
    let response = tokio::select! {
        biased;
        _ = cancel.notified() => return Some(NetEvent::End { cancelled: true }),
        r = client.execute(request) => r,
    };
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            return Some(NetEvent::Failed {
                message: e.without_url().to_string(),
            })
        }
    };
    let clean = |text: &str| match secret {
        Some(s) if !s.is_empty() => text.replace(s, "***"),
        _ => text.to_string(),
    };
    let headers = response
        .headers()
        .iter()
        .filter(|(name, _)| name.as_str() != "set-cookie")
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.as_str().to_string(), clean(v)))
        })
        .collect();
    let status = response.status();
    emit(NetEvent::Head {
        status: status.as_u16(),
        headers,
    });
    let mut body = response.bytes_stream();
    if status.is_client_error() || status.is_server_error() {
        // 错误响应不长，读完再去掉密钥：密钥可能跨两块，流式替换会漏。
        let mut buf = Vec::new();
        let ending = loop {
            tokio::select! {
                biased;
                _ = cancel.notified() => break NetEvent::End { cancelled: true },
                chunk = body.next() => match chunk {
                    Some(Ok(bytes)) => {
                        buf.extend_from_slice(&bytes);
                        if buf.len() >= MAX_ERROR_BODY {
                            buf.truncate(MAX_ERROR_BODY);
                            break NetEvent::End { cancelled: false };
                        }
                    }
                    Some(Err(e)) => break NetEvent::Failed { message: e.without_url().to_string() },
                    None => break NetEvent::End { cancelled: false },
                },
            }
        };
        if !buf.is_empty() {
            let data = secret.map_or(buf.clone(), |s| redact(&buf, s));
            emit(NetEvent::Chunk { data });
        }
        return Some(ending);
    }
    loop {
        tokio::select! {
            biased;
            _ = cancel.notified() => return Some(NetEvent::End { cancelled: true }),
            chunk = body.next() => match chunk {
                Some(Ok(bytes)) => emit(NetEvent::Chunk { data: bytes.to_vec() }),
                Some(Err(e)) => return Some(NetEvent::Failed { message: e.without_url().to_string() }),
                None => return Some(NetEvent::End { cancelled: false }),
            },
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
    let id = prepared.id().to_string();
    tauri::async_runtime::spawn(async move {
        let canceller = proxy.clone();
        proxy
            .run(prepared, move |event| {
                // 界面已关闭或不再接收时停止读取，不再空读计费的输出。
                if channel.send(event).is_err() {
                    canceller.cancel(&id);
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_replaces_every_occurrence() {
        assert_eq!(
            redact(b"key sk-1 and sk-1sk-1 end", "sk-1"),
            b"key *** and ****** end".to_vec()
        );
        assert_eq!(redact(b"abc", ""), b"abc".to_vec());
    }

    #[test]
    fn early_cancels_are_bounded() {
        let proxy = Proxy::new(Arc::new(MemoryCredentials::default()));
        for i in 0..EARLY_CANCEL_MAX + 100 {
            assert!(!proxy.cancel(&format!("r{i}")));
        }
        assert_eq!(proxy.early_cancels(), EARLY_CANCEL_MAX);
    }

    #[tokio::test]
    async fn limiter_resizes_in_place() {
        let mut limiter = Limiter::new(3);
        let semaphore = limiter.semaphore.clone();
        let held: Vec<_> = (0..3)
            .map(|_| Slot {
                permit: Some(semaphore.clone().try_acquire_owned().unwrap()),
                debt: limiter.debt.clone(),
            })
            .collect();
        // 三个都在用时降到 1：欠 2 个，前两个结束时不归还。
        limiter.resize(1);
        assert_eq!(limiter.debt.load(Ordering::SeqCst), 2);
        drop(held);
        assert_eq!(semaphore.available_permits(), 1);
        assert_eq!(limiter.debt.load(Ordering::SeqCst), 0);
        // 有欠额时升高，先抵欠额。
        let a = semaphore.clone().try_acquire_owned().unwrap();
        limiter.resize(0);
        assert_eq!(limiter.debt.load(Ordering::SeqCst), 1);
        limiter.resize(4);
        assert_eq!(limiter.debt.load(Ordering::SeqCst), 0);
        assert_eq!(semaphore.available_permits(), 3);
        drop(a);
        assert_eq!(semaphore.available_permits(), 4);
    }
}
