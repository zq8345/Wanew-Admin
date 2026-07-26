// #5 产品视频渲染契约·自测
// 目的：钉死 admin 侧 videos[] 数据形状 + 官网侧渲染模板，官网接时零歧义。
// 断言：validateProduct 产出的 videos[] 经"契约模板"+resolveImg(与官网同一函数,vendored) 渲出预期 <video>。
// 跑：node --experimental-strip-types scripts/video-contract.test.mjs
import { validateProduct } from "../src/publish.ts";
import { resolveImg } from "../vendor/render.js";

const IMG_BASE = "https://img.wanew.com/";
const cats = { categories: [{ slug: "cables" }] };
const base = (videos) => ({ category: "cables", i18n: { en: { title: "T", description_html: "<p>x</p>" } }, images: [{ key: "u_file/a.webp", alt: "" }], videos });

// ⭐ 官网渲染契约模板（定死·官网 render.js 按此实现）：
//   <video controls preload="none"[ poster="{resolveImg(poster)}"]><source src="{resolveImg(video)}" type="video/mp4"></video>
export function renderVideoContract(v, imgBase) {
  const poster = v.poster ? ` poster="${resolveImg(v.poster, imgBase)}"` : "";
  return `<video controls preload="none"${poster}><source src="${resolveImg(v, imgBase)}" type="video/mp4"></video>`;
}

let pass = 0, fail = 0;
const eq = (name, got, exp) => { got === exp ? pass++ : (fail++, console.log("✗", name, "\n   got:", got, "\n   exp:", exp)); };
const ok = (name, c) => c ? pass++ : (fail++, console.log("✗", name));

// 样例1：key + poster + title + alt
let p = validateProduct(base([{ key: "u_file/install.mp4", poster: { key: "u_file/install.poster.webp" }, title: "Installation", alt: "安装演示" }]), 1, cats, null).prod;
ok("①videos[0] 形状", JSON.stringify(p.videos[0]) === JSON.stringify({ key: "u_file/install.mp4", poster: { key: "u_file/install.poster.webp" }, title: "Installation", alt: "安装演示" }));
eq("①渲染", renderVideoContract(p.videos[0], IMG_BASE),
  `<video controls preload="none" poster="https://img.wanew.com/u_file/install.poster.webp"><source src="https://img.wanew.com/u_file/install.mp4" type="video/mp4"></video>`);

// 样例2：key 无 poster 无 title（poster 属性不出现）
p = validateProduct(base([{ key: "u_file/demo.mp4" }]), 1, cats, null).prod;
ok("②无 poster/title 形状", JSON.stringify(p.videos[0]) === JSON.stringify({ key: "u_file/demo.mp4", alt: "" }));
eq("②渲染(无 poster 属性)", renderVideoContract(p.videos[0], IMG_BASE),
  `<video controls preload="none"><source src="https://img.wanew.com/u_file/demo.mp4" type="video/mp4"></video>`);

// 样例3：src(相对路径) 形态 → resolveImg 原样
p = validateProduct(base([{ src: "/static/upload/x.mp4", poster: { src: "/static/upload/x.webp" } }]), 1, cats, null).prod;
eq("③src 形态渲染", renderVideoContract(p.videos[0], IMG_BASE),
  `<video controls preload="none" poster="/static/upload/x.webp"><source src="/static/upload/x.mp4" type="video/mp4"></video>`);

// 样例4：多视频顺序保留
p = validateProduct(base([{ key: "u_file/1.mp4" }, { key: "u_file/2.mp4" }]), 1, cats, null).prod;
ok("④多视频顺序", p.videos.length === 2 && p.videos[0].key === "u_file/1.mp4" && p.videos[1].key === "u_file/2.mp4");

// 样例5：无 videos → 字段不落盘（零迁移·官网无 videos 时不渲染视频区）
ok("⑤无 videos 不落盘", !("videos" in validateProduct(base(undefined), 1, cats, null).prod));

console.log(`\n== 视频渲染契约自测: ${pass} 过 / ${fail} 挂 ==`);
process.exit(fail ? 1 : 0);
