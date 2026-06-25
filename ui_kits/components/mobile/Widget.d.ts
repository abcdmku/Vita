import * as React from 'react';
/** Home/lock-screen widget card with an overline title. */
export interface WidgetProps { title?: string; children?: React.ReactNode; width?: number | string; translucent?: boolean; }
export function Widget(props: WidgetProps): JSX.Element;
