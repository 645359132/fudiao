//! 凭据代理（M2-01）：本机起一个最小的 HTTP 服务，检查凭据注入、主机白名单、流式转发、取消、并发上限与不跟随重定向。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fudiao_lib::net::{
    Auth, Binding, KeyHeader, MemoryCredentials, NetError, NetEvent, NetRequest, Proxy,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const SECRET: &str = "sk-real-secret";

/// 收到的请求（原始文本）与同时处理的最大连接数。
#[derive(Default)]
struct Server {
    requests: Mutex<Vec<String>>,
    active: AtomicUsize,
    max_active: AtomicUsize,
}

async fn read_request(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text[..end]
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if buf.len() >= end + 4 + length {
                return text;
            }
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// 按路径回应：/stream 分三块发送，/slow 发一块后停住，/redirect 返回 302，其他返回 200。
async fn serve(server: Arc<Server>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let server = server.clone();
            tokio::spawn(async move {
                let request = read_request(&mut stream).await;
                let now = server.active.fetch_add(1, Ordering::SeqCst) + 1;
                server.max_active.fetch_max(now, Ordering::SeqCst);
                server.requests.lock().unwrap().push(request.clone());
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let head = |status: &str, extra: &str| {
                    format!("HTTP/1.1 {status}\r\nconnection: close\r\ncontent-type: text/event-stream\r\n{extra}\r\n")
                };
                match path.as_str() {
                    "/stream" => {
                        stream
                            .write_all(head("200 OK", "set-cookie: a=b\r\n").as_bytes())
                            .await
                            .unwrap();
                        for part in ["data: 一\n\n", "data: 二\n\n", "data: 三\n\n"] {
                            stream.write_all(part.as_bytes()).await.unwrap();
                            stream.flush().await.unwrap();
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    }
                    "/slow" => {
                        stream
                            .write_all(head("200 OK", "").as_bytes())
                            .await
                            .unwrap();
                        stream.write_all(b"data: first\n\n").await.unwrap();
                        stream.flush().await.unwrap();
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    "/hold" => {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        stream
                            .write_all(head("200 OK", "").as_bytes())
                            .await
                            .unwrap();
                        stream.write_all(b"ok").await.unwrap();
                    }
                    "/echo-key" => {
                        // 中转站把收到的请求头写进错误说明，密钥分在两块里发出。
                        let key = request
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("x-api-key: ")
                                    .or_else(|| l.strip_prefix("authorization: Bearer "))
                            })
                            .unwrap_or("")
                            .to_string();
                        let (a, b) = key.split_at(key.len() / 2);
                        stream
                            .write_all(
                                head("401 Unauthorized", &format!("x-echo: {key}\r\n")).as_bytes(),
                            )
                            .await
                            .unwrap();
                        stream
                            .write_all(format!("{{\"error\":\"bad key {a}").as_bytes())
                            .await
                            .unwrap();
                        stream.flush().await.unwrap();
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        stream
                            .write_all(format!("{b}\"}}").as_bytes())
                            .await
                            .unwrap();
                    }
                    "/redirect" => {
                        stream
                            .write_all(
                                head("302 Found", "location: https://evil.example.test/steal\r\n")
                                    .as_bytes(),
                            )
                            .await
                            .unwrap();
                    }
                    _ => {
                        stream
                            .write_all(head("200 OK", "").as_bytes())
                            .await
                            .unwrap();
                        stream.write_all(b"ok").await.unwrap();
                    }
                }
                let _ = stream.shutdown().await;
                server.active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    base
}

fn proxy_for(base: &str, auth: Auth, concurrency: usize) -> Arc<Proxy> {
    let credentials = Arc::new(MemoryCredentials::default());
    credentials.set("p1", Binding::new(base, auth, concurrency).unwrap());
    Arc::new(Proxy::new(credentials))
}

fn api_key(header: KeyHeader) -> Auth {
    Auth::ApiKey {
        header,
        secret: SECRET.into(),
    }
}

fn request(id: &str, url: String) -> NetRequest {
    NetRequest {
        id: id.into(),
        provider_id: "p1".into(),
        url,
        method: "POST".into(),
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("x-api-key".into(), "placeholder".into()),
            ("Authorization".into(), "Bearer placeholder".into()),
            ("anthropic-version".into(), "2023-06-01".into()),
        ],
        body: Some(r#"{"model":"m"}"#.into()),
    }
}

async fn collect(proxy: &Proxy, req: NetRequest) -> Vec<NetEvent> {
    let prepared = proxy.prepare(req).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    proxy
        .run(prepared, move |e| sink.lock().unwrap().push(e))
        .await;
    let out = events.lock().unwrap().clone();
    out
}

fn body_text(events: &[NetEvent]) -> String {
    let bytes: Vec<u8> = events
        .iter()
        .flat_map(|e| match e {
            NetEvent::Chunk { data } => data.clone(),
            _ => vec![],
        })
        .collect();
    String::from_utf8(bytes).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn injects_the_credential_and_drops_placeholders() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    for (header, expected) in [
        (KeyHeader::XApiKey, format!("x-api-key: {SECRET}")),
        (KeyHeader::Bearer, format!("authorization: Bearer {SECRET}")),
    ] {
        let proxy = proxy_for(&base, api_key(header), 4);
        let events = collect(&proxy, request("r1", format!("{base}/v1/messages"))).await;
        assert_eq!(events.last(), Some(&NetEvent::End { cancelled: false }));
        let received = server
            .requests
            .lock()
            .unwrap()
            .pop()
            .unwrap()
            .to_ascii_lowercase();
        assert!(
            received.contains(&expected.to_ascii_lowercase()),
            "{received}"
        );
        assert!(!received.contains("placeholder"), "{received}");
        assert!(received.contains("anthropic-version: 2023-06-01"));
        assert!(received.ends_with(r#"{"model":"m"}"#));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_the_response_and_hides_cookies() {
    let base = serve(Arc::new(Server::default())).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    let events = collect(&proxy, request("r1", format!("{base}/stream"))).await;
    match &events[0] {
        NetEvent::Head { status, headers } => {
            assert_eq!(*status, 200);
            assert!(headers
                .iter()
                .any(|(k, v)| k == "content-type" && v == "text/event-stream"));
            assert!(!headers.iter().any(|(k, _)| k == "set-cookie"));
        }
        other => panic!("{other:?}"),
    }
    assert!(
        events
            .iter()
            .filter(|e| matches!(e, NetEvent::Chunk { .. }))
            .count()
            >= 2
    );
    assert_eq!(body_text(&events), "data: 一\n\ndata: 二\n\ndata: 三\n\n");
    assert_eq!(events.last(), Some(&NetEvent::End { cancelled: false }));
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_other_hosts_before_sending_anything() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::Bearer), 4);
    let port: u32 = base.rsplit(':').next().unwrap().parse().unwrap();
    let other_port = format!(
        "http://127.0.0.1:{}/x",
        if port == 65535 { port - 1 } else { port + 1 }
    );
    for url in [
        "https://evil.example.test/v1/chat/completions".to_string(),
        other_port,
        base.replace("127.0.0.1", "localhost"),
    ] {
        let err = proxy.prepare(request("r1", url)).err().unwrap();
        assert!(matches!(err, NetError::HostNotAllowed { .. }), "{err:?}");
    }
    let mut unknown = request("r1", format!("{base}/x"));
    unknown.provider_id = "nope".into();
    assert_eq!(
        proxy.prepare(unknown).err(),
        Some(NetError::UnknownProvider)
    );
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn bindings_require_https_and_keyless_endpoints_must_be_local() {
    let key = api_key(KeyHeader::Bearer);
    assert!(Binding::new("https://api.example.test/v1", key.clone(), 4).is_ok());
    assert_eq!(
        Binding::new("http://api.example.test/v1", key.clone(), 4).err(),
        Some(NetError::InsecureScheme)
    );
    assert!(Binding::new("http://127.0.0.1:11434/v1", Auth::None, 4).is_ok());
    assert!(Binding::new("http://localhost:1234/v1", Auth::None, 4).is_ok());
    assert!(Binding::new("http://[::1]:8000/v1", Auth::None, 4).is_ok());
    assert!(matches!(
        Binding::new("https://api.example.test/v1", Auth::None, 4).err(),
        Some(NetError::HostNotAllowed { .. })
    ));
    // 绑定的是源：路径不同仍是同一个服务，默认端口与显式端口相同。
    assert_eq!(
        Binding::new("https://api.example.test:443/v1", key.clone(), 4)
            .unwrap()
            .origin,
        "https://api.example.test"
    );
    // 调试输出中不出现密钥。
    assert!(!format!("{:?}", Binding::new("https://a.test", key, 4).unwrap()).contains(SECRET));
}

#[tokio::test(flavor = "multi_thread")]
async fn does_not_follow_redirects() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    let events = collect(&proxy, request("r1", format!("{base}/redirect"))).await;
    match &events[0] {
        NetEvent::Head { status, headers } => {
            assert_eq!(*status, 302);
            assert!(headers
                .iter()
                .any(|(k, v)| k == "location" && v.starts_with("https://evil")));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_keeps_what_has_arrived() {
    let base = serve(Arc::new(Server::default())).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    let prepared = proxy
        .prepare(request("r1", format!("{base}/slow")))
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let runner = proxy.clone();
    let task = tokio::spawn(async move {
        runner
            .run(prepared, move |e| sink.lock().unwrap().push(e))
            .await
    });
    // 等到第一块到达再取消。
    for _ in 0..100 {
        if events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, NetEvent::Chunk { .. }))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(proxy.cancel("r1"));
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    let events = events.lock().unwrap().clone();
    assert_eq!(body_text(&events), "data: first\n\n");
    assert_eq!(events.last(), Some(&NetEvent::End { cancelled: true }));
    // 结束后标识可以再用，取消未知标识返回 false。
    assert!(!proxy.cancel("r1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_before_start_sends_nothing() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    // 取消与开始同时就绪时不能靠运气：重复多次，任何一次把请求发出去都算失败。
    for i in 0..50 {
        let id = format!("r{i}");
        let prepared = proxy.prepare(request(&id, format!("{base}/x"))).unwrap();
        assert!(proxy.cancel(&id));
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        proxy
            .run(prepared, move |e| sink.lock().unwrap().push(e))
            .await;
        assert_eq!(
            *events.lock().unwrap(),
            vec![NetEvent::End { cancelled: true }]
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_ids_are_rejected_while_running() {
    let base = serve(Arc::new(Server::default())).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    let _first = proxy.prepare(request("r1", format!("{base}/x"))).unwrap();
    assert_eq!(
        proxy.prepare(request("r1", format!("{base}/x"))).err(),
        Some(NetError::DuplicateId)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn limits_concurrent_requests_per_origin() {
    for (limit, expected) in [(1, 1), (3, 3)] {
        let server = Arc::new(Server::default());
        let base = serve(server.clone()).await;
        let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), limit);
        let tasks: Vec<_> = (0..3)
            .map(|i| {
                let prepared = proxy
                    .prepare(request(&format!("r{i}"), format!("{base}/hold")))
                    .unwrap();
                let runner = proxy.clone();
                tokio::spawn(async move { runner.run(prepared, |_| {}).await })
            })
            .collect();
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(server.requests.lock().unwrap().len(), 3);
        assert_eq!(
            server.max_active.load(Ordering::SeqCst),
            expected,
            "上限 {limit}"
        );
    }
}

#[test]
fn events_and_errors_serialize_like_the_typescript_types() {
    assert_eq!(
        serde_json::to_value(NetEvent::Head {
            status: 200,
            headers: vec![("a".into(), "b".into())]
        })
        .unwrap(),
        serde_json::json!({ "event": "head", "status": 200, "headers": [["a", "b"]] })
    );
    assert_eq!(
        serde_json::to_value(NetEvent::Chunk { data: vec![1, 2] }).unwrap(),
        serde_json::json!({ "event": "chunk", "data": [1, 2] })
    );
    assert_eq!(
        serde_json::to_value(NetEvent::End { cancelled: true }).unwrap(),
        serde_json::json!({ "event": "end", "cancelled": true })
    );
    assert_eq!(
        serde_json::to_value(NetError::HostNotAllowed {
            origin: "https://x".into()
        })
        .unwrap(),
        serde_json::json!({ "code": "host_not_allowed", "origin": "https://x" })
    );
    let parsed: NetRequest = serde_json::from_value(serde_json::json!({
        "id": "r", "providerId": "p", "url": "https://x", "method": "POST", "headers": [["a", "b"]], "body": null
    }))
    .unwrap();
    assert_eq!(parsed.provider_id, "p");
}

#[tokio::test(flavor = "multi_thread")]
async fn configured_limits_override_the_default() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    proxy.set_limits(&[("p1".into(), 1)]);
    let tasks: Vec<_> = (0..3)
        .map(|i| {
            let prepared = proxy
                .prepare(request(&format!("r{i}"), format!("{base}/hold")))
                .unwrap();
            let runner = proxy.clone();
            tokio::spawn(async move { runner.run(prepared, |_| {}).await })
        })
        .collect();
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(server.max_active.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_that_arrives_before_fetch_still_wins() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), 4);
    // 界面的取消与 net_fetch 是两次调用，取消可能先到：这时代理还不认识这个标识。
    assert!(!proxy.cancel("r1"));
    let events = collect(&proxy, request("r1", format!("{base}/x"))).await;
    assert_eq!(events, vec![NetEvent::End { cancelled: true }]);
    // 记录只用一次：同一标识再来一次照常发出。
    let events = collect(&proxy, request("r1", format!("{base}/x"))).await;
    assert_eq!(events.last(), Some(&NetEvent::End { cancelled: false }));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn error_responses_do_not_echo_the_key() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    for header in [KeyHeader::XApiKey, KeyHeader::Bearer] {
        let proxy = proxy_for(&base, api_key(header), 4);
        let req = request("r1", format!("{base}/echo-key"));
        let events = collect(&proxy, req).await;
        let text = format!("{events:?}");
        assert!(!text.contains(SECRET), "{text}");
        assert!(matches!(
            events.first(),
            Some(NetEvent::Head { status: 401, .. })
        ));
        assert_eq!(events.last(), Some(&NetEvent::End { cancelled: false }));
        assert_eq!(body_text(&events), "{\"error\":\"bad key ***\"}");
        assert!(text.contains("(\"x-echo\", \"***\")"), "{text}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn services_sharing_an_origin_share_one_limit() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let credentials = Arc::new(MemoryCredentials::default());
    credentials.set(
        "p1",
        Binding::new(&base, api_key(KeyHeader::XApiKey), 1).unwrap(),
    );
    credentials.set(
        "p2",
        Binding::new(&base, api_key(KeyHeader::XApiKey), 3).unwrap(),
    );
    let proxy = Arc::new(Proxy::new(credentials));
    let tasks: Vec<_> = (0..8)
        .map(|i| {
            let mut req = request(&format!("r{i}"), format!("{base}/hold"));
            req.provider_id = if i % 2 == 0 { "p1" } else { "p2" }.into();
            let prepared = proxy.prepare(req).unwrap();
            let runner = proxy.clone();
            tokio::spawn(async move { runner.run(prepared, |_| {}).await })
        })
        .collect();
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(server.requests.lock().unwrap().len(), 8);
    assert!(server.max_active.load(Ordering::SeqCst) <= 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_limits_are_capped() {
    let server = Arc::new(Server::default());
    let base = serve(server.clone()).await;
    let proxy = proxy_for(&base, api_key(KeyHeader::XApiKey), usize::MAX);
    proxy.set_limits(&[("p1".into(), usize::MAX)]);
    let events = collect(&proxy, request("r1", format!("{base}/x"))).await;
    assert_eq!(events.last(), Some(&NetEvent::End { cancelled: false }));
}
