/**
 * Roving tabindex for a radiogroup/tablist: the group is ONE tab stop, arrows move within it.
 *
 * The fallback is the point. `selected ? 0 : -1` alone means that when nothing is selected — a
 * fresh form, a cleared filter, a value that matches no option — every item is `-1` and the whole
 * control becomes unreachable by keyboard. `SegmentedControl` shipped exactly that.
 */
export declare function rovingTabIndex(isSelected: boolean, selectedIndex: number, index: number): 0 | -1;
