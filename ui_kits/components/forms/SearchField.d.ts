import * as React from 'react';
/** Command-style search field with leading prompt glyph and a keyboard-shortcut chip. */
export interface SearchFieldProps {
  placeholder?: string;
  /** Shortcut chip text. @default "⌘K" */
  shortcut?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}
export function SearchField(props: SearchFieldProps): JSX.Element;
