import * as React from 'react';
/** Mobile status bar (time + signal/battery). Inherits color from the theme. */
export interface PhoneStatusBarProps { time?: string; }
export function PhoneStatusBar(props: PhoneStatusBarProps): JSX.Element;
