// SPDX-License-Identifier: GPL-3.0-only
// The two-pages view of both apps (not in MuseScore): facing pages, with odd page numbers on the right like Page::isOdd.

/** the indexes of the left and right page of a page's spread; left is -1 or right past the end if that side is empty */
export function spreadPages(page: number, firstPageIsRight: boolean): { left: number; right: number } {
    const shift = firstPageIsRight ? 1 : 0
    const left = Math.floor((page + shift) / 2) * 2 - shift
    return { left, right: left + 1 }
}

/** the page to go to for the next or previous spread */
export function stepSpread(page: number, dir: 1 | -1, firstPageIsRight: boolean): number {
    return Math.max(0, spreadPages(page, firstPageIsRight).left + 2 * dir)
}
