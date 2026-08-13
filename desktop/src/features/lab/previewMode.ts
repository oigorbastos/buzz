export function isLabV2Preview(): boolean {
  const isPreviewCapable =
    import.meta.env.DEV || import.meta.env.MODE === "e2e";
  if (!isPreviewCapable) return false;

  return (
    import.meta.env.VITE_LAB_PREVIEW === "1" ||
    new URLSearchParams(window.location.search).get("preview") === "lab-v2"
  );
}
