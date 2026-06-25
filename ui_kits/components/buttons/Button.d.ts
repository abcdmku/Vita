import * as React from 'react';
/**
 * Primary action button — four variants, three sizes.
 * @startingPoint section="Buttons" subtitle="primary / secondary / ghost / destructive" viewport="380x60"
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** @default 'primary' */
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Optional leading monospace glyph, e.g. ">_" */
  icon?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}
export function Button(props: ButtonProps): JSX.Element;
