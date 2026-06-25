import * as React from 'react';
/**
 * Floating window frame. Neutral dot controls; set `tiling` for sharp-corner pane chrome and `accentBorder` for the focused tile.
 * @startingPoint section="OS" subtitle="App window frame" viewport="720x440"
 */
export interface WindowChromeProps { title?: string; children?: React.ReactNode; width?: number; height?: number; focused?: boolean; tiling?: boolean; accentBorder?: boolean; }
export function WindowChrome(props: WindowChromeProps): JSX.Element;
