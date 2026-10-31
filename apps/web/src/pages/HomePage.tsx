import { ArrowRight, ArrowUpRight, Ellipsis, FileUp, ImagePlus, Plus, Send, Sparkles } from "lucide-react";
import { useState } from "react";
import { useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { AppHeader } from "../components/AppHeader";
import { sampleProjects } from "../lib/samples";
import { api, ApiError } from "@canvas/api-client";

type HomeProject = { id: string; title: string; updated: string; art: string; image: string; canvasId: string };

function formatUpdated(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "刚刚修改" : `最近修改 · ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

export function HomePage() {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [projects, setProjects] = useState<HomeProject[]>(sampleProjects.map((project) => ({ ...project, canvasId: project.id })));
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.listProjects().then(async (records) => {
      const grouped = await Promise.all(records.map(async (project) => ({ project, canvases: await api.listCanvases(project.id) })));
      if (!active) return;
      const boards = grouped.flatMap(({ project, canvases }) => canvases.map((canvas, index) => ({
        id: canvas.id,
        title: canvas.name || project.name,
        updated: formatUpdated(canvas.updated_at),
        art: ["art-bloom", "art-mountain", "art-brand"][index % 3],
        image: ["/assets/bloom.svg", "/assets/mountain.svg", "/assets/skincare.svg"][index % 3],
        canvasId: canvas.id,
      })));
      setProjects(boards);
      setSignedIn(true);
    }).catch((cause) => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) setSignedIn(false);
      else setError(cause instanceof ApiError ? cause.message : "无法连接服务端，请确认 API 已启动。");
    });
    return () => { active = false; };
  }, []);

  async function startCanvas() {
    if (!signedIn) {
      navigate("/login");
      return;
    }
    try {
      const canvas = await api.createCanvas("未命名画布");
      navigate(`/canvas/${canvas.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "无法创建画布，请重试。");
    }
  }

  return (
    <div className="home-page dotted-page">
      <AppHeader active="canvases" />
      <main className="home-content">
        <section className="home-hero">
          <div className="hero-star"><Sparkles size={16} /></div>
          <h1>把灵感，放到一张无限画布上</h1>
          <p>从一张空白画布开始，或让 Agent 帮你梳理想法、规划画面。</p>
          <form className="hero-prompt" onSubmit={(event) => { event.preventDefault(); startCanvas(); }}>
            <button className="prompt-attach" type="button" aria-label="添加参考图片" onClick={() => navigate("/assets")}><ImagePlus size={19} /></button>
            <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述你想创作的内容，或先上传图片素材，再让 Agent 帮你整理画布…" />
            <button className="prompt-send" type="submit" aria-label="开始创作"><Send size={17} /></button>
          </form>
          <button className="button button-light hero-create" onClick={startCanvas}><Plus size={19} /> 新建画布</button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </section>

        <section className="recent-section">
          <div className="section-heading">
            <h2>最近编辑</h2>
            <button className="text-link" onClick={startCanvas}>查看全部 <ArrowRight size={15} /></button>
          </div>
          <div className="project-grid">
            {projects.map((project) => (
              <article className="project-card" key={project.id}>
                <Link to={`/canvas/${project.canvasId}`} className={`project-art ${project.art}`} aria-label={`打开${project.title}`}>
                  <img src={project.image} alt="" />
                  <div className="art-caption"><span>{project.id === "spring" ? "Natural\nSkincare" : project.id === "story" ? "Scene 01\n雨夜 · 消息" : "SORA"}</span></div>
                  {project.id === "spring" && <div className="art-swatch-row"><i /><i /><i /><i /></div>}
                  {project.id === "story" && <div className="art-scene-strip"><b /><b /><b /><b /></div>}
                  {project.id === "brand" && <div className="art-brand-note"><span>自然与生活的平衡</span><strong>品牌视觉</strong></div>}
                </Link>
                <div className="project-meta">
                  <div><h3>{project.title}</h3><p>{project.updated}</p></div>
                  <button className="icon-button project-more" aria-label={`${project.title}选项`}><Ellipsis size={19} /></button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="import-board">
          <FileUp size={22} />
          <span><strong>导入已有画布</strong><small>支持 .flow、图片或其他格式文件</small></span>
          <ArrowUpRight size={17} className="import-arrow" />
        </section>
        <footer className="home-footnote">你的想法保存在自己的工作区里</footer>
      </main>
    </div>
  );
}
