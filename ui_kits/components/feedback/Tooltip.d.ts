import * as React from 'react';
/** Hover label, optionally with a keyboard shortcut. Dark in both themes. */
export interface TooltipProps { label?: string; shortcut?: string; children?: React.ReactNode; }
export function Tooltip(props: TooltipProps): JSX.Element;
