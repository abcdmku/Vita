import * as React from 'react';
/** Square icon-only button carrying a Lucide icon. */
export interface IconButtonProps {
  /** Lucide icon name, e.g. "settings", "plus". */
  icon?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'solid';
  active?: boolean;
  label?: string;
  onClick?: () => void;
}
export function IconButton(props: IconButtonProps): JSX.Element;
