export function fitNotificationPopup(popup: HTMLElement, placeholder: HTMLElement,
  observe: (callback: ResizeObserverCallback) => ResizeObserver = callback => new ResizeObserver(callback)): () => void {
  const previous = placeholder.style.getPropertyValue("height");
  const priority = placeholder.style.getPropertyPriority("height");
  const resize = () => {
    const styles = placeholder.ownerDocument.defaultView!.getComputedStyle(placeholder);
    const padding = [styles.paddingTop, styles.paddingBottom, styles.borderTopWidth, styles.borderBottomWidth]
      .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    const needed = Math.ceil(Math.max(40, popup.getBoundingClientRect().height) + 40);
    const height = styles.boxSizing === "border-box" ? needed : Math.max(0, needed - padding);
    placeholder.style.setProperty("height", `${height}px`, "important");
  };
  resize();
  const observer = observe(resize);
  observer.observe(popup);
  return () => {
    observer.disconnect();
    if (previous) placeholder.style.setProperty("height", previous, priority);
    else placeholder.style.removeProperty("height");
  };
}
