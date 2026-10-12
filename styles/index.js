function onImageLoaded(img) {
  const placeholder = img.parentElement.querySelector(".placeholder");
  if (placeholder) placeholder.style.display = "none";
  img.style.opacity = "1";
}

function onImageFailed(img) {
  const container = img.parentElement;
  container.innerHTML = '<div class="img-fallback"><span>:^(</span></div>';
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".card-image-container img").forEach((img) => {
    if (img.complete) {
      if (img.naturalHeight !== 0) {
        onImageLoaded(img);
      } else {
        onImageFailed(img);
      }
      return;
    }
    img.addEventListener("load", () => onImageLoaded(img), { once: true });
    img.addEventListener("error", () => onImageFailed(img), { once: true });
  });
});
