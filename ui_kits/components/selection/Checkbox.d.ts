import * as React from 'react';
/** Square checkbox with optional label. */
export interface CheckboxProps { checked?: boolean; label?: React.ReactNode; disabled?: boolean; onChange?: (checked: boolean) => void; }
export function Checkbox(props: CheckboxProps): JSX.Element;
