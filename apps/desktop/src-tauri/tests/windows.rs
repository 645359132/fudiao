//! 每个窗口各开一部作品（作者决定 2026-10-23）：作品库按窗口记下，同一部作品只开在一个窗口里，窗口关掉时忘掉。

use fudiao_lib::db::{
    commands::{same_dir, DbState, Reserve},
    migrate::Migration,
    Database,
};

const NOW: &str = "2026-10-23T00:00:00.000Z";
const M1: Migration = Migration {
    version: 1,
    name: "create_work",
    sql: "CREATE TABLE work (id TEXT PRIMARY KEY);\n",
};

fn open(dir: &std::path::Path) -> Database {
    Database::open(dir, &[M1], NOW).expect("打开作品库").0
}

#[test]
fn each_window_keeps_its_own_work_and_one_work_opens_in_one_window() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("甲");
    let b = root.path().join("乙");
    let state = DbState::default();

    assert_eq!(state.put("main", open(&a)), Ok(()));
    assert_eq!(state.put("work-1", open(&b)), Ok(()));
    assert_eq!(state.holder(&a, "work-1").as_deref(), Some("main"));
    assert_eq!(state.holder(&b, "main").as_deref(), Some("work-1"));
    // 自己开着的不算“别的窗口开着”。
    assert_eq!(state.holder(&a, "main"), None);

    // 同一部作品不能再开在另一个窗口里；同一个窗口换一部作品可以。
    assert_eq!(state.put("work-2", open(&a)), Err("main".to_string()));
    let c = root.path().join("丙");
    assert_eq!(state.put("main", open(&c)), Ok(()));
    assert_eq!(state.holder(&a, ""), None);

    // 窗口关掉以后，它开的作品可以在别的窗口里打开。
    state.forget("work-1");
    assert_eq!(state.holder(&b, ""), None);
    assert_eq!(state.put("work-2", open(&b)), Ok(()));
}

#[test]
fn same_dir_ignores_trailing_slashes_and_on_windows_case_and_separators() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("作品");
    std::fs::create_dir_all(&dir).unwrap();
    let with_slash = std::path::PathBuf::from(format!("{}/", dir.display()));
    assert!(same_dir(&dir, &with_slash));
    assert!(!same_dir(&dir, &root.path().join("别的")));
    if cfg!(windows) {
        let upper =
            std::path::PathBuf::from(dir.display().to_string().to_uppercase().replace('\\', "/"));
        assert!(same_dir(&dir, &upper));
    }
}

#[test]
fn a_work_being_opened_or_restored_is_reserved_and_a_closed_window_never_gets_it() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("甲");
    let state = DbState::default();

    // 正在打开（迁移、备份可能要好几秒）：别的窗口打不开同一部。
    assert_eq!(state.reserve("work-1", &a), Ok(()));
    assert_eq!(state.holder(&a, "main").as_deref(), Some("work-1"));
    assert_eq!(
        state.reserve("work-2", &a),
        Err(Reserve::HeldBy("work-1".into()))
    );
    assert!(state.settle("work-1", Some(open(&a))));
    assert_eq!(state.holder(&a, "main").as_deref(), Some("work-1"));

    // 打开到一半窗口关掉了：打开结束时不再记到它名下，别的窗口可以打开。
    let b = root.path().join("乙");
    assert_eq!(state.reserve("work-3", &b), Ok(()));
    state.forget("work-3");
    assert!(!state.settle("work-3", Some(open(&b))));
    assert_eq!(state.holder(&b, ""), None);
    assert_eq!(state.reserve("work-3", &b), Err(Reserve::Closed));
    assert_eq!(state.put("main", open(&b)), Ok(()));

    // 打开失败：放下占位。
    let c = root.path().join("丙");
    assert_eq!(state.reserve("work-4", &c), Ok(()));
    assert!(!state.settle("work-4", None));
    assert_eq!(state.holder(&c, ""), None);
}
