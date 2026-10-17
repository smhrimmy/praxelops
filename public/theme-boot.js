// Runs before first paint (loaded via next/script beforeInteractive from layout.tsx).
// Applies the stored theme, else the OS preference (light only if the OS asks for it), else dark.
(function () {
  var theme = "dark";
  try {
    var stored = window.localStorage.getItem("praxelops-theme");
    if (stored === "light" || stored === "dark") {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      theme = "light";
    }
  } catch (e) {
    // Storage blocked: fall back to the OS preference / dark default.
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
