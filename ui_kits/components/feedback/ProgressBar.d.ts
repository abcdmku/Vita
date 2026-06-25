import * as React from 'react';
/** Determinate progress / system meter. Use accent for CPU/MEM, success for network, etc. */
export interface ProgressBarProps { value?: number; max?: number; label?: string; accent?: string; width?: number | string; }
export function ProgressBar(props: ProgressBarProps): JSX.Element;
