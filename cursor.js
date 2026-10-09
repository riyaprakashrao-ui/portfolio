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
