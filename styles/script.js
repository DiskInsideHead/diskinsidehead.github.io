(() => {
  const BLOCK_DELAY_STEP = 0.28;
  const MAX_SNOWFLAKES = 78;
  const EASTER_EGG_CLICKS = 20;
  const SNOWFLAKE_IMAGES = ["/sourcetools/aigis.png", "/sourcetools/toast.png"];
  const MUSIC_URL =
    "https://storage6.lightaudio.ru/dm/399224fb/2044acaa/ATLUS%20—%20Aria%20of%20the%20Soul.mp3?d=337&v=a9a13d7712";

  function staggerBlocks() {
    let delay = BLOCK_DELAY_STEP;
    document.querySelectorAll(".animated-block").forEach((block) => {
      block.style.animationDelay = `${delay}s`;
      delay += BLOCK_DELAY_STEP;
    });
  }

  function addHomeButton() {
    const tooltip = "Home Page";
    const button = document.createElement("a");
    button.href = "/";
    button.className = "btn btn-primary position-fixed d-flex align-items-center justify-content-center";
    button.innerHTML = '<i class="fi-home"></i>';
    button.setAttribute("aria-label", tooltip);
    button.setAttribute("data-bs-toggle", "tooltip");
    button.setAttribute("data-bs-placement", "right");
    button.title = tooltip;

    Object.assign(button.style, {
      left: "20px",
      bottom: "20px",
      width: "50px",
      height: "50px",
      borderRadius: "50%",
      zIndex: "1000",
      boxShadow: "0 4px 8px rgba(0,0,0,0.2)",
      transition: "all 0.3s ease",
    });

    button.addEventListener("mouseenter", () => {
      button.style.transform = "scale(1.1)";
      button.style.boxShadow = "0 6px 12px rgba(0,0,0,0.3)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.transform = "scale(1)";
      button.style.boxShadow = "0 4px 8px rgba(0,0,0,0.2)";
    });

    document.body.appendChild(button);

    if (typeof bootstrap !== "undefined") {
      new bootstrap.Tooltip(button);
    }
  }

  function createMusicControls() {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `
      <div class="d-flex justify-content-center d-none" id="volume-control-container" style="position: fixed; top: 10px; left: 0; right: 0; z-index: 1000;">
        <input class="form-range" id="volume-control" max="0.3" min="0" step="0.001" style="width: 400px; max-width: 90vw;" type="range" value="0.1">
      </div>
      <audio id="background-music" loop preload="none" src="${MUSIC_URL}"></audio>`,
    );

    const volumeControl = document.getElementById("volume-control");
    const music = document.getElementById("background-music");
    music.volume = volumeControl.value;
    volumeControl.addEventListener("input", () => {
      music.volume = volumeControl.value;
    });
    return { volumeControl, music };
  }

  function setupEasterEgg({ music }) {
    const trigger = document.getElementById("drop-area");
    if (!trigger) return;

    let clicks = 0;
    let snowflakes = [];

    function applyBlueTheme() {
      document.getElementById("volume-control-container").classList.remove("d-none");
      document.body.classList.add("blue-theme-body");
      document.querySelectorAll("h1, h2, h3").forEach((heading) => heading.classList.add("blue-theme-text"));
      music.volume = 0.1;
      music.play().catch(() => {});
    }

    function createSnowflake() {
      if (snowflakes.length > MAX_SNOWFLAKES) return;

      const size = Math.floor(Math.random() * 51) + 30;
      const flake = new Image(size, size);
      flake.src = SNOWFLAKE_IMAGES[Math.floor(Math.random() * SNOWFLAKE_IMAGES.length)];
      flake.classList.add("aigis");
      flake.style.left = `${Math.random() * (window.innerWidth - 75)}px`;
      flake.style.setProperty("--fall-duration", `${Math.random() * 5 + 5}s`);
      flake.style.setProperty("--side-duration", `${Math.random() * 5 + 5}s`);

      document.body.appendChild(flake);
      snowflakes.push(flake);
      setTimeout(() => {
        flake.style.opacity = 1;
      }, 10);

      flake.addEventListener("animationend", () => {
        flake.remove();
        snowflakes = snowflakes.filter((item) => item !== flake);
      });
    }

    trigger.addEventListener("click", () => {
      clicks++;
      if (clicks === EASTER_EGG_CLICKS) {
        applyBlueTheme();
        setInterval(createSnowflake, 600);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    staggerBlocks();
    addHomeButton();
    setupEasterEgg(createMusicControls());
  });
})();
