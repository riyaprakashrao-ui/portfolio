// Drop .html from the address bar. GitHub Pages already serves the same file without it.
(function () {
  const path = location.pathname;
  if (!path.endsWith(".html")) return;
  const clean = path.endsWith("/index.html")
    ? path.slice(0, -"index.html".length)
    : path.slice(0, -".html".length);
  history.replaceState(null, "", clean + location.search + location.hash);
})();

// Replaces the mouse pointer with a blue dot. Over a project image it becomes a "see more" label.
// Skipped on touch screens, where there's no pointer to replace.

if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML = '<span class="cursor-dot"></span><span class="cursor-label">see more →</span>';
  document.body.appendChild(cursor);
  document.documentElement.classList.add("has-custom-cursor");

  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    // Modal dialogs sit above everything, so fall back to the normal pointer inside them.
    const inDialog = !!e.target.closest?.("dialog");
    cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    cursor.classList.toggle("is-visible", !inDialog);
    const play = e.target.closest?.(".case-play-link");
    const seeMore = e.target.closest?.(".card-image");
    cursor.classList.toggle("is-see-more", !!(play || seeMore));
    cursor.querySelector(".cursor-label").textContent = play ? "press to play →" : "see more →";
    cursor.classList.toggle("is-link", !!e.target.closest?.("a, button"));
  });

  document.documentElement.addEventListener("mouseleave", () => cursor.classList.remove("is-visible"));
}

document.querySelector(".case-bottombar .to-top")?.addEventListener("click", () => {
  scrollTo({ top: 0 });
});

// Warm the image cache before those pictures are on screen. The files stay full quality;
// they just start downloading while the visitor is still on an earlier page.
(function () {
  if (navigator.connection?.saveData) return;

  let path = location.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  else if (!path.endsWith("/")) path = path.replace(/[^/]+$/, "");
  if (path.endsWith("/work/")) path = path.slice(0, -"work/".length);
  const root = path;

  const pages = [
    ["work/kiosk", [
      "assets/case-5/kiosk.svg",
      "assets/case-5/research-1.svg?v=2",
      "assets/case-5/research-2.svg?v=2",
      "assets/case-5/research-3.svg?v=2",
      "assets/case-5/storyboard1.svg",
      "assets/case-5/wireframes.svg",
      "assets/case-5/keyfeats.svg",
      "assets/case-5/build.svg",
    ]],
    ["work/capitalone", [
      "assets/case-1/hero.png",
      "assets/case-1/panda.png",
      "assets/case-1/sitemap.png",
    ]],
    ["work/junior-firefighter", [
      "assets/case-4/jrfirefighter.svg",
    ]],
    ["work/fireflies", [
      "assets/case-3/paper-prototype-row.png",
      "assets/case-3/research.svg",
      "assets/case-3/assumptions.svg",
      "assets/case-3/storyboard.png",
      "assets/case-3/paper-prototype.png",
    ]],
    ["work/colearn", [
      "assets/case-4/hero.svg",
      "assets/case-4/relationships.svg",
      "assets/case-4/features.svg",
    ]],
    ["work/ucsd-health", [
      "assets/case-6/condom-week.png",
      "assets/case-6/wellbeing-fair.png",
      "assets/case-6/student-well-fest.png",
      "assets/case-6/therapy-fluffies.png",
      "assets/case-6/quit.png",
    ]],
  ];

  const here = location.pathname.replace(/\.html$/, "").replace(/\/$/, "");
  const onPage = (key) => here.endsWith("/" + key) || here.endsWith(key);

  const already = new Set(
    [...document.images].map((img) => img.currentSrc || img.src).filter(Boolean)
  );

  const queue = [];
  const seen = new Set();
  for (const [key, files] of pages) {
    if (onPage(key)) continue;
    for (const file of files) {
      const url = new URL(file, location.origin + root).href;
      if (already.has(url) || seen.has(url)) continue;
      seen.add(url);
      queue.push(url);
    }
  }

  // The page you're on still gets its own later pictures started immediately,
  // in case the browser hasn't reached them yet.
  const current = pages.find(([key]) => onPage(key));
  if (current) {
    for (const file of current[1]) {
      const url = new URL(file, location.origin + root).href;
      if (already.has(url) || seen.has(url)) continue;
      seen.add(url);
      queue.unshift(url);
    }
  }

  let cursor = 0;
  let inFlight = 0;
  const concurrency = 2;
  function pump() {
    while (cursor < queue.length && inFlight < concurrency) {
      const url = queue[cursor++];
      const img = new Image();
      inFlight++;
      img.onload = img.onerror = () => {
        inFlight--;
        pump();
      };
      img.src = url;
    }
  }

  const start = () => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
    idle(() => pump());
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start);
  else start();
})();
