import * as React from 'react';
/** iOS-style toggle for instant on/off settings. */
export interface SwitchProps { on?: boolean; disabled?: boolean; onChange?: (on: boolean) => void; }
export function Switch(props: SwitchProps): JSX.Element;
