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

document.querySelectorAll("video[data-play-in-view]").forEach((video) => {
  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    },
    { threshold: 0.45 }
  );
  io.observe(video);
});
