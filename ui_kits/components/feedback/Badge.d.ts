import * as React from 'react';
/** Small status pill. */
export interface BadgeProps { children?: React.ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; dot?: boolean; }
export function Badge(props: BadgeProps): JSX.Element;
