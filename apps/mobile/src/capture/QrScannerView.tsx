import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { colors, spacing, typography } from '../ui/theme';

/**
 * QR scanner for pairing (PAIR-002).
 *
 * Only the first successful scan is reported: the pairing token is single-use, and reporting it
 * twice would look like a replay to the server.
 */
export function QrScannerView({
  onScanned,
  paused,
}: {
  onScanned: (value: string) => void;
  paused?: boolean;
}): React.JSX.Element {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const reported = React.useRef(false);

  React.useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  React.useEffect(() => {
    reported.current = false;
  }, [paused]);

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: useCallback(
      (codes: Array<{ value?: string }>) => {
        if (paused || reported.current) return;
        const value = codes.find(
          (code) => typeof code.value === 'string' && code.value.length > 0,
        )?.value;
        if (!value) return;
        reported.current = true;
        onScanned(value);
      },
      [onScanned, paused],
    ),
  });

  if (!hasPermission) {
    return (
      <View style={styles.message}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.body}>
          Allow camera access so you can scan the pairing code shown on your computer.
        </Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.message}>
        <Text style={styles.title}>No camera found</Text>
        <Text style={styles.body}>Enter the pairing details manually instead.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!paused}
        codeScanner={codeScanner}
      />
      <View style={styles.frame} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  frame: {
    position: 'absolute',
    top: '22%',
    left: '12%',
    right: '12%',
    bottom: '22%',
    borderWidth: 3,
    borderColor: colors.primary,
    borderRadius: 16,
  },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  title: { ...typography.subtitle, marginBottom: spacing.sm, textAlign: 'center' },
  body: { ...typography.muted, textAlign: 'center' },
});
