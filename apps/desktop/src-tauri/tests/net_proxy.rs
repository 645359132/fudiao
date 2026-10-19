//! 回环源的请求不经系统代理（硬性规则 16）：设了 HTTP_PROXY 时，发往本机服务的请求（含 API Key 与正文）也直接连本机。
//! 单独成一个测试文件（独立进程），设置的代理环境变量不影响其他测试。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use fudiao_lib::net::{Auth, Binding, KeyHeader, MemoryCredentials, NetEvent, NetRequest, Proxy};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 接受连接、读一次、回 200；记下连接数。
async fn listen(count: Arc<AtomicUsize>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 2\r\n\r\nok",
                    )
                    .await;
                let _ = stream.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread")]
async fn loopback_requests_bypass_proxy_settings() {
    let proxied = Arc::new(AtomicUsize::new(0));
    let direct = Arc::new(AtomicUsize::new(0));
    let proxy_url = listen(proxied.clone()).await;
    let base = listen(direct.clone()).await;
    for name in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        std::env::set_var(name, &proxy_url);
    }
    // NO_PROXY 为空时 Windows 会改用系统设置的例外（常含 127.*），掩盖问题；设一个无关的值，只看环境变量。
    for name in ["NO_PROXY", "no_proxy"] {
        std::env::set_var(name, "example.invalid");
    }

    let credentials = Arc::new(MemoryCredentials::default());
    let auth = Auth::ApiKey {
        header: KeyHeader::XApiKey,
        secret: "sk-real-secret".into(),
    };
    credentials.set("p1", Binding::new(&base, auth, 4).unwrap());
    let proxy = Proxy::new(credentials);
    let prepared = proxy
        .prepare(NetRequest {
            id: "r1".into(),
            provider_id: "p1".into(),
            url: format!("{base}/v1/messages"),
            method: "POST".into(),
            headers: vec![],
            body: Some("{}".into()),
        })
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    proxy
        .run(prepared, move |e| sink.lock().unwrap().push(e))
        .await;

    assert_eq!(
        events.lock().unwrap().last(),
        Some(&NetEvent::End { cancelled: false })
    );
    assert_eq!(direct.load(Ordering::SeqCst), 1);
    assert_eq!(proxied.load(Ordering::SeqCst), 0, "请求经过了代理");
}
