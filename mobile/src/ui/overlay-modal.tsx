import type { ReactNode } from 'react';
import { Modal, Platform, StyleSheet, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

/**
 * A transparent full-screen layer for dialogs and menus.
 *
 * On iOS, React Native's `Modal` is presented from the root view controller. When a native sheet or full-screen modal (our add/edit
 * forms and detail screens) is already open, iOS refuses that second presentation: the dialog never appears and a dead layer is left
 * swallowing every touch. `FullWindowOverlay` draws in its own window above everything, including open sheets, so dialogs always show.
 * Android keeps the normal `Modal` (which also handles the back button).
 */
export function OverlayModal({ visible, onRequestClose, children }: { visible: boolean; onRequestClose?: () => void; children: ReactNode }) {
  if (Platform.OS === 'ios' && process.env.JEST_WORKER_ID === undefined) {
    if (!visible) return null;
    return (
      <FullWindowOverlay>
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">{children}</View>
      </FullWindowOverlay>
    );
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose} statusBarTranslucent>{children}</Modal>;
}
