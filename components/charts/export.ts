/** Export a self-contained SVG with resolved theme colors, or rasterize it locally. */
export async function exportChart(element: HTMLElement, format: "svg" | "png", filename: string): Promise<void> {
  const original = element.querySelector<SVGSVGElement>("svg[data-explore-chart]");
  if (!original) throw new Error("Choose a chart before exporting an image.");
  const clone = original.cloneNode(true) as SVGSVGElement;
  const source = [original, ...original.querySelectorAll<SVGElement>("*")];
  const target = [clone, ...clone.querySelectorAll<SVGElement>("*")];
  const properties = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight", "letter-spacing", "text-anchor", "color"];
  for (let index = 0; index < source.length; index++) {
    const computed = getComputedStyle(source[index]);
    for (const property of properties) target[index].style.setProperty(property, computed.getPropertyValue(property));
    target[index].removeAttribute("tabindex");
    target[index].removeAttribute("role");
    target[index].removeAttribute("class");
  }
  const viewBox = original.viewBox.baseVal;
  const width = Math.max(1, viewBox.width || original.getBoundingClientRect().width);
  const height = Math.max(1, viewBox.height || original.getBoundingClientRect().height);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", "100%"); background.setAttribute("height", "100%");
  background.setAttribute("fill", getComputedStyle(element).getPropertyValue("--surface").trim() || "#ffffff");
  clone.insertBefore(background, clone.firstChild);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" });
  let downloadBlob = blob;
  if (format === "png") {
    const imageUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The chart could not be converted to PNG. Try SVG instead.")); image.src = imageUrl; });
      const canvas = document.createElement("canvas");
      const scale = Math.min(2, 4096 / Math.max(width, height));
      canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PNG export is unavailable in this browser. Try SVG instead.");
      context.scale(scale, scale); context.drawImage(image, 0, 0, width, height);
      downloadBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("The chart could not be converted to PNG.")), "image/png"));
    } finally { URL.revokeObjectURL(imageUrl); }
  }
  const url = URL.createObjectURL(downloadBlob);
  try {
    const link = document.createElement("a");
    link.href = url; link.download = `${filename.replace(/[^\w .-]/g, "_").slice(0, 120) || "dataforge-chart"}.${format}`;
    document.body.append(link); link.click(); link.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1_000); }
}
