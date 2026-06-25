import * as React from 'react';
/** Notification card. `icon` is a Lucide name mirroring the app. */
export interface ToastProps { icon?: string; app?: string; title?: string; body?: string; time?: string; tone?: 'accent' | 'success' | 'danger'; }
export function Toast(props: ToastProps): JSX.Element;
