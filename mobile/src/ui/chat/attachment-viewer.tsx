import { useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeError } from '../../lib/errors';
import { formatFileSize } from '../../lib/chat/messages';
import { saveAttachment } from '../../services/attachment-file';
import { Text } from '../components';
import { Icon } from '../icon';
import { OverlayModal } from '../overlay-modal';
import { radius, space } from '../theme';
import { useToast } from '../toast';
import { CALL } from './call-colors';

export interface ViewedAttachment { url: string; fileName: string; mimeType: string; sizeBytes: number }

/** Full-screen view of a photo, or a details card for a document, with Save and (for documents) Open. */
export function AttachmentViewer({ file, image, video = false, onClose }: { file: ViewedAttachment | null; image: boolean; video?: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!file || busy) return;
    setBusy(true);
    try { await saveAttachment(file.url, file.fileName, file.mimeType); } catch (e) { toast.show(describeError(e), 'error'); } finally { setBusy(false); }
  }
  const button = (label: string, icon: 'download-outline' | 'open-outline' | 'play-outline', onPress: () => void, primary: boolean) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={busy} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, paddingHorizontal: space.xl, height: 48, borderRadius: radius.pill, backgroundColor: primary ? CALL.ok : CALL.glass, opacity: busy ? 0.6 : 1 }}>
      {busy && primary ? <ActivityIndicator color={CALL.fg} /> : <Icon name={icon} size="md" color={CALL.fg} />}
      <Text bold color={CALL.fg}>{label}</Text>
    </Pressable>
  );
  return (
    <OverlayModal visible={!!file} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: CALL.black, paddingTop: insets.top, paddingBottom: insets.bottom + space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space.md, gap: space.md }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose}><Icon name="close" size="lg" color={CALL.fg} /></Pressable>
          <Text color={CALL.fg} numberOfLines={1} style={{ flex: 1 }}>{file?.fileName}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.md }}>
          {file && image ? <Image accessibilityIgnoresInvertColors accessibilityLabel={file.fileName} source={{ uri: file.url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
            : file ? (
              <View style={{ alignItems: 'center', gap: space.md }}>
                <Icon name={video ? 'play-circle-outline' : 'document-text-outline'} size={72} color={CALL.fg} />
                <Text bold color={CALL.fg} style={{ textAlign: 'center' }}>{file.fileName}</Text>
                <Text variant="caption" color={CALL.fg}>{formatFileSize(file.sizeBytes)}</Text>
              </View>
            ) : null}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.md, padding: space.md }}>
          {button('Save to phone', 'download-outline', () => void save(), true)}
          {file && !image ? button(video ? 'Play' : 'Open', video ? 'play-outline' : 'open-outline', () => void Linking.openURL(file.url).catch(() => toast.show('No app can open this file.', 'error')), false) : null}
        </View>
      </View>
    </OverlayModal>
  );
}
