import * as React from 'react';
/** A single Lucide icon, recolored via currentColor. Requires the Lucide UMD script on the page. */
export interface IconProps {
  /** Lucide icon name, e.g. "terminal", "folder", "wifi". */
  name?: string;
  /** Pixel size (square). @default 18 */
  size?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
}
export function Icon(props: IconProps): JSX.Element;
