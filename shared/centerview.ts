// SPDX-License-Identifier: GPL-3.0-only
// The center button of both apps (the action view-center-page; not in MuseScore).

/** rounding of the zoom (e.g. the fit modes) */
const FIT_TOLERANCE_PX = 1

/**
 * Moves the view to a measure: if its page fits into the view (width and height) the page is centered (in a spread: the
 * spread, if that fits too), otherwise the measure.
 * pageEl: the element of the page; pageWidth, rect: inches, rect relative to the page's top left.
 */
export function centerViewOnMeasureOrPage(viewport: HTMLElement, pageEl: HTMLElement, pageWidth: number, rect: { x: number; y: number; width: number; height: number }): void {
    const vr = viewport.getBoundingClientRect()
    const fits = (r: DOMRect): boolean => r.width <= viewport.clientWidth + FIT_TOLERANCE_PX && r.height <= viewport.clientHeight + FIT_TOLERANCE_PX
    const pr = pageEl.getBoundingClientRect()
    const spread = pageEl.parentElement?.classList.contains('spread') ? pageEl.parentElement.getBoundingClientRect() : null
    const shown = spread && fits(spread) ? spread : pr
    let centerX: number
    let centerY: number
    if (fits(shown)) {
        centerX = shown.left + shown.width / 2
        centerY = shown.top + shown.height / 2
    } else {
        const f = pr.width / pageWidth
        centerX = pr.left + (rect.x + rect.width / 2) * f
        centerY = pr.top + (rect.y + rect.height / 2) * f
    }
    viewport.scrollLeft += centerX - (vr.left + viewport.clientWidth / 2)
    viewport.scrollTop += centerY - (vr.top + viewport.clientHeight / 2)
}
