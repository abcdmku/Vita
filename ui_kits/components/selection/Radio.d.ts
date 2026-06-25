import * as React from 'react';
/** Single-choice radio. Manage selection in the parent and pass `selected`. */
export interface RadioProps { selected?: boolean; label?: React.ReactNode; name?: string; disabled?: boolean; onSelect?: () => void; }
export function Radio(props: RadioProps): JSX.Element;
