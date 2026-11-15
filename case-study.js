// Builds the side tracker from every <section class="case-section"> on the page,
// using its data-nav label (or its <h2> text), and highlights the one in view.

const sections = [...document.querySelectorAll(".case-section")];
const tracker = document.querySelector(".tracker");
const toTop = document.querySelector(".to-top");

const links = sections.map((section, i) => {
  if (!section.id) section.id = `section-${i + 1}`;
  const label = section.dataset.nav || section.querySelector("h2")?.textContent || `Section ${i + 1}`;

  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = `#${section.id}`;
  a.textContent = label;
  li.appendChild(a);
  tracker.appendChild(li);
  return a;
});

function update() {
  // A section is "current" once its top passes 40% of the way down the screen.
  const line = innerHeight * 0.4;
  let current = 0;
  sections.forEach((s, i) => {
    if (s.getBoundingClientRect().top <= line) current = i;
  });

  const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
  if (atBottom) current = sections.length - 1;

  links.forEach((a, i) => a.classList.toggle("is-active", i === current));
  if (toTop && !toTop.closest(".case-bottombar")) {
    toTop.classList.toggle("is-visible", scrollY > innerHeight * 0.6);
  }
}

addEventListener("scroll", update, { passive: true });
addEventListener("resize", update);
update();

toTop?.addEventListener("click", () => scrollTo({ top: 0 }));

/* Pandas process steps: click a block to reveal a one-line explanation underneath. */
const pandasRoot = document.querySelector("[data-pandas]");
if (pandasRoot) {
  const detail = pandasRoot.querySelector("[data-pandas-detail]");
  const steps = [...pandasRoot.querySelectorAll("[data-pandas-step]")];
  const explanations = [
    "Read in the survey results and preserved N/A values because they represented a real answer (due to differing roles) rather than a null value.",
    "Kept each person’s latest submission in case of duplicates, retained usable partial responses, standardized categories such as designer or FE developer or tenure, checked that incomplete responses were not disproportionately concentrated in one group.",
    "Represented ordered responses such as Strongly Agree to Strongly Disagree with 1–5 labels.",
    "Grouped and aggregated responses by variables such as role and tenure to produce consistent distributions and identity patterns.",
    "Reviewed subgroup sizes, missingness, and response counts before interpreting the results.",
  ];

  steps.forEach((step, i) => {
    step.addEventListener("click", () => {
      const alreadyOpen = step.getAttribute("aria-selected") === "true";
      steps.forEach((s) => s.setAttribute("aria-selected", "false"));
      if (alreadyOpen) {
        detail.hidden = true;
        detail.textContent = "";
        return;
      }
      step.setAttribute("aria-selected", "true");
      detail.textContent = explanations[i];
      detail.hidden = false;
    });
  });
}

/* Click a zoomable figure to open the original file at its native size. */
const lightbox = document.getElementById("imageLightbox");
const lightboxImg = document.getElementById("lightboxImg");
const lightboxClose = document.getElementById("lightboxClose");
if (lightbox && lightboxImg) {
  document.querySelectorAll("[data-lightbox]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const img = btn.querySelector("img");
      if (!img) return;
      lightboxImg.src = img.currentSrc || img.src;
      lightboxImg.alt = img.alt;
      lightbox.showModal();
    });
  });
  lightboxClose?.addEventListener("click", () => lightbox.close());
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) lightbox.close();
  });
}

document.querySelectorAll(".case-scroll").forEach((frame) => {
  const track = frame.parentElement.querySelector(".case-scroll-track");
  const thumb = track?.querySelector(".case-scroll-thumb");

  const place = () => {
    if (!track || !thumb) return;
    const max = frame.scrollHeight - frame.clientHeight;
    const trackH = track.clientHeight;
    const thumbH = Math.max(36, trackH * (frame.clientHeight / frame.scrollHeight));
    const travel = Math.max(1, trackH - thumbH);
    const top = max <= 0 ? 0 : (frame.scrollTop / max) * travel;
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${top}px)`;
  };

  frame.addEventListener("scroll", place, { passive: true });
  frame.querySelector("img")?.addEventListener("load", place);
  place();

  const stopAuto = () => {
    frame.dataset.userScroll = "true";
  };

  frame.addEventListener("wheel", stopAuto, { passive: true });
  frame.addEventListener("touchstart", stopAuto, { passive: true });
  frame.addEventListener("pointerdown", stopAuto);
  frame.addEventListener("keydown", stopAuto);

  if (thumb && track) {
    thumb.addEventListener("pointerdown", (event) => {
      stopAuto();
      event.preventDefault();
      const startY = event.clientY;
      const startTop = frame.scrollTop;
      const move = (ev) => {
        const max = frame.scrollHeight - frame.clientHeight;
        const travel = Math.max(1, track.clientHeight - thumb.getBoundingClientRect().height);
        frame.scrollTop = startTop + ((ev.clientY - startY) / travel) * max;
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    track.addEventListener("pointerdown", (event) => {
      if (event.target === thumb) return;
      stopAuto();
      const rect = track.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / rect.height;
      frame.scrollTop = ratio * (frame.scrollHeight - frame.clientHeight);
    });
  }

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let running = false;
  let raf = 0;

  const step = () => {
    if (!running || frame.dataset.userScroll === "true") return;
    const max = frame.scrollHeight - frame.clientHeight;
    if (frame.scrollTop >= max - 1) {
      running = false;
      return;
    }
    frame.scrollTop += 0.7;
    raf = requestAnimationFrame(step);
  };

  const io = new IntersectionObserver(
    ([entry]) => {
      if (frame.dataset.userScroll === "true") return;
      const onScreen = entry.isIntersecting && entry.intersectionRatio >= 0.45;
      if (onScreen && !running) {
        running = true;
        raf = requestAnimationFrame(step);
      } else if (!onScreen) {
        running = false;
        cancelAnimationFrame(raf);
      }
    },
    { threshold: [0, 0.45] }
  );
  io.observe(frame);
});

document.querySelectorAll("video[data-src]").forEach((video) => {
  const start = () => {
    if (!video.getAttribute("src")) video.src = video.dataset.src;
    video.play().catch(() => {});
  };
  if (!("IntersectionObserver" in window)) {
    start();
    return;
  }
  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) start();
      else video.pause();
    },
    { rootMargin: "0px", threshold: 0.35 }
  );
  io.observe(video);
});
