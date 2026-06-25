import * as React from 'react';
/** Single-line text field with focus ring, prefix slot and invalid state. */
export interface InputProps {
  value?: string;
  placeholder?: string;
  type?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Leading monospace affix, e.g. "~/" */
  prefix?: React.ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}
export function Input(props: InputProps): JSX.Element;
