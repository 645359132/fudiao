/** 应用外壳。作品管理、章节目录与编辑器在 M1-04、M1-05 加入。 */
export function App() {
  return (
    <main className="shell">
      <aside className="shell-sidebar" aria-label="章节目录">
        <h2>章节</h2>
        <p className="shell-empty">还没有打开作品</p>
      </aside>
      <section className="shell-editor" aria-label="正文">
        <h1>小说编辑器</h1>
        <p>新建或打开一部作品后，在这里写作。</p>
      </section>
    </main>
  );
}
