import * as React from 'react';
/** Device bezel with notch pill. Screen background follows the current theme (wrap in .theme-dark for dark). */
export interface PhoneFrameProps { children?: React.ReactNode; width?: number; }
export function PhoneFrame(props: PhoneFrameProps): JSX.Element;
