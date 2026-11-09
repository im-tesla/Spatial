(() => {
  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reveal only when we can actually observe. Without JS the content stays visible.
  const revealItems = [...document.querySelectorAll("[data-reveal]")];
  if (revealItems.length && !reduced && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    revealItems.forEach(item => observer.observe(item));
    root.classList.add("reveal-ready");
  } else {
    revealItems.forEach(item => item.classList.add("is-visible"));
  }

  const header = document.querySelector("[data-header]");
  const progress = document.querySelector(".scroll-progress span");
  const navLinks = [...document.querySelectorAll(".site-nav a")];
  const sections = navLinks.map(link => ({ link, element: document.querySelector(link.getAttribute("href")) }))
    .filter(item => item.element);
  const download = document.querySelector("#download");
  const gallery = document.querySelector(".gallery");
  let queued = false;

  function updateScroll() {
    queued = false;
    const y = window.scrollY;
    header?.classList.toggle("is-scrolled", y > 18);
    const overDownload = download
      && y + 76 >= download.offsetTop
      && y < download.offsetTop + download.offsetHeight;
    header?.classList.toggle("on-light", !!overDownload && y > 18);
    if (progress) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, y / max)) : 0})`;
    }
    const marker = y + window.innerHeight * 0.42;
    let current = null;
    for (const section of sections) if (section.element.offsetTop <= marker) current = section.link;
    if (gallery && marker >= gallery.offsetTop) current = null;
    for (const link of navLinks) {
      const active = link === current;
      link.classList.toggle("is-current", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }

  function onScroll() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(updateScroll);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  updateScroll();

  // A small live lyric loop for the hero card.
  const demo = document.querySelector("[data-demo-lyrics]");
  if (demo) {
    const lines = [...demo.querySelectorAll("p")];
    const clock = document.querySelector("[data-demo-time]");
    const fill = document.querySelector(".now-progress span");
    let index = 0;
    const show = next => {
      index = next;
      lines.forEach((line, lineIndex) => {
        line.classList.toggle("is-active", lineIndex === index);
        line.classList.toggle("is-past", lineIndex < index);
      });
      if (clock) clock.textContent = `0:${String(lines[index].dataset.time || 0).padStart(2, "0")} / 0:20`;
      if (fill) fill.style.width = `${((index + 1) / lines.length) * 100}%`;
    };
    show(0);
    if (!reduced && lines.length > 1) window.setInterval(() => show((index + 1) % lines.length), 3500);
  }

  // Release assets are read from the latest published release. Static links remain usable
  // when the API is unavailable or rate limited.
  const releaseRoot = "https://github.com/im-tesla/Spatial/releases";
  fetch("https://api.github.com/repos/im-tesla/Spatial/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
  }).then(response => {
    if (!response.ok) throw new Error("release unavailable");
    return response.json();
  }).then(release => {
    if (!release || !release.tag_name) return;
    const version = String(release.tag_name);
    document.querySelectorAll("[data-release-version]").forEach(element => { element.textContent = version; });

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const find = pattern => assets.find(asset => pattern.test(asset.name || ""));
    const urls = {
      windows: find(/setup\.exe$/i)?.browser_download_url,
      appimage: find(/\.AppImage$/i)?.browser_download_url,
      deb: find(/\.deb$/i)?.browser_download_url,
    };
    const fallback = release.html_url || `${releaseRoot}/latest`;
    const set = (kind, url) => document.querySelectorAll(`[data-download="${kind}"]`)
      .forEach(link => { link.href = url || fallback; });
    set("windows", urls.windows);
    set("appimage", urls.appimage);
    set("deb", urls.deb);
    set("all", releaseRoot);

    const userAgent = navigator.userAgent;
    const platform = /Windows/i.test(userAgent) ? "windows" : /Linux/i.test(userAgent) ? "appimage" : "";
    const preferred = platform ? urls[platform] : "";
    const labels = document.querySelectorAll("[data-download-label]");
    labels.forEach(label => {
      label.textContent = platform === "windows" ? "Download for Windows"
        : platform === "appimage" ? "Download for Linux"
          : "Download latest";
    });
    const detail = document.querySelector("[data-primary-detail]");
    if (detail) detail.textContent = platform === "windows" ? "Windows installer"
      : platform === "appimage" ? "Linux AppImage" : "Latest desktop release";
    document.querySelectorAll('[data-download="primary"]').forEach(link => { link.href = preferred || fallback; });
  }).catch(() => {
    // Fallback links already point at the latest release page.
  });
})();
