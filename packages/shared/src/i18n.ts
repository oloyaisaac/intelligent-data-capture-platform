/**
 * Internationalisation. No user-facing string is hardcoded in a component (AI.md §5).
 * English ships now; adding a locale means adding a catalogue here — no component changes.
 */

export type Locale = 'en' | 'sw' | 'fr';

export const SUPPORTED_LOCALES: Locale[] = ['en', 'sw', 'fr'];

const en = {
  'nav.overview': 'Overview',
  'nav.documents': 'Documents',
  'nav.batches': 'Batches',
  'nav.review': 'Review',
  'nav.exports': 'Exports',
  'nav.projects': 'Projects',
  'nav.templates': 'Templates',
  'nav.connectors': 'Connectors',
  'nav.devices': 'Devices',
  'nav.settings': 'Settings',
  'nav.configure': 'Configure',
  'settings.language': 'Language',
  'settings.languageHint': 'Interface language. Missing translations fall back to English.',
  'app.name': 'IDCP',
  'app.tagline': 'Capture documents. Get clean data.',
  'action.cancel': 'Cancel',
  'action.continue': 'Continue',
  'action.retry': 'Try again',
  'action.save': 'Save',
  'action.close': 'Close',
  'action.export': 'Export',
  'action.approve': 'Approve',
  'action.reject': 'Reject',
  'action.reprocess': 'Reprocess',
  'action.rename': 'Rename',
  'action.revoke': 'Revoke',
  'action.signIn': 'Sign in',
  'action.signOut': 'Sign out',
  'action.register': 'Create account',
  'pairing.title': 'Pair a device',
  'pairing.instructions': 'Open the IDCP app on your phone and scan this code.',
  'pairing.expiresIn': 'Expires in {seconds}s',
  'pairing.expired': 'This pairing code has expired. Generate a new one.',
  'pairing.used': 'This pairing code has already been used.',
  'pairing.success': 'Device paired successfully.',
  'pairing.scan': 'Scan pairing code',
  'pairing.invalidCode': 'That code is not valid. Try again.',
  'pairing.permissionDenied': 'Camera access is needed to scan the code.',
  'device.list': 'Paired devices',
  'device.lastSeen': 'Last seen {when}',
  'device.revoked': 'Device access revoked.',
  'device.revokeConfirm': 'Revoke this device? It will need to be paired again.',
  'capture.title': 'Capture document',
  'capture.guide': 'Fit the page inside the frame',
  'capture.takePhoto': 'Take photo',
  'capture.retake': 'Retake',
  'capture.usePhoto': 'Use photo',
  'capture.queued': 'Saved. Uploading when connected.',
  'capture.uploading': 'Uploading…',
  'capture.uploaded': 'Uploaded',
  'capture.failed': 'Upload failed. Will retry automatically.',
  'queue.title': 'Uploads',
  'queue.empty': 'Nothing waiting to upload.',
  'queue.offline': 'You are offline. Captures are saved on this device.',
  'review.title': 'Review',
  'review.empty': 'Nothing to review. Nice work.',
  'review.needsReview': 'Needs review',
  'review.fieldCorrected': 'Corrected',
  'review.confirmAll': 'Confirm all fields',
  'review.approved': 'Record approved.',
  'review.rejected': 'Record rejected.',
  'review.blockedByFields': 'Fix the highlighted fields before approving.',
  'review.bulkSkipped': '{count} record(s) skipped: unresolved fields.',
  'review.confidence': 'Confidence {percent}%',
  'document.status.uploaded': 'Uploaded',
  'document.status.queued': 'Queued',
  'document.status.processing': 'Processing',
  'document.status.extracted': 'Extracted',
  'document.status.needs_review': 'Needs review',
  'document.status.approved': 'Approved',
  'document.status.failed': 'Failed',
  'document.status.deleted': 'Deleted',
  'export.title': 'Export',
  'export.xlsx': 'Excel workbook',
  'export.csv': 'CSV file',
  'export.ready': 'Export ready',
  'export.failed': 'Export failed. Try again.',
  'export.empty': 'No approved records match those filters.',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.invalid': 'Email or password is incorrect.',
  'auth.passwordRule': 'Use at least 12 characters.',
  'error.generic': 'Something went wrong. Please try again.',
  'error.network': 'Cannot reach the server. Check your connection.',
  'error.forbidden': 'You do not have permission to do that.',
  'error.notFound': 'Not found.',
  'error.rateLimited': 'Too many attempts. Wait a moment and try again.',
  'error.offlineMode': 'Working offline. Changes will sync when connected.',
} as const;

export type TranslationKey = keyof typeof en;

export type Catalogue = Record<TranslationKey, string>;

const sw: Partial<Catalogue> = {
  'nav.overview': 'Muhtasari',
  'nav.documents': 'Nyaraka',
  'nav.batches': 'Makundi',
  'nav.review': 'Kagua',
  'nav.exports': 'Hamisha',
  'nav.projects': 'Miradi',
  'nav.templates': 'Violezo',
  'nav.connectors': 'Viunganishi',
  'nav.devices': 'Vifaa',
  'nav.settings': 'Mipangilio',
  'nav.configure': 'Sanidi',
  'settings.language': 'Lugha',
  'settings.languageHint': 'Lugha ya kiolesura. Tafsiri zisizokuwepo zitarudi kwa Kiingereza.',
  'app.tagline': 'Piga picha hati. Pata data safi.',
  'action.cancel': 'Ghairi',
  'action.continue': 'Endelea',
  'action.retry': 'Jaribu tena',
  'action.save': 'Hifadhi',
  'action.close': 'Funga',
  'action.export': 'Hamisha',
  'action.approve': 'Kubali',
  'action.reject': 'Kataa',
  'action.signIn': 'Ingia',
  'action.signOut': 'Toka',
  'pairing.title': 'Oanisha kifaa',
  'pairing.instructions': 'Fungua programu ya IDCP kwenye simu yako na piga picha msimbo huu.',
  'pairing.expiresIn': 'Inaisha baada ya sekunde {seconds}',
  'pairing.expired': 'Msimbo huu umeisha muda. Tengeneza mpya.',
  'pairing.success': 'Kifaa kimeoanishwa.',
  'capture.title': 'Piga picha hati',
  'capture.guide': 'Weka ukurasa ndani ya fremu',
  'capture.takePhoto': 'Piga picha',
  'capture.uploading': 'Inapakia…',
  'queue.title': 'Vipakiaji',
  'queue.offline': 'Huna mtandao. Picha zimehifadhiwa kwenye kifaa.',
  'review.title': 'Kagua',
  'review.needsReview': 'Inahitaji ukaguzi',
  'review.approved': 'Rekodi imekubaliwa.',
  'export.title': 'Hamisha',
  'auth.email': 'Barua pepe',
  'auth.password': 'Nenosiri',
  'error.generic': 'Hitilafu imetokea. Tafadhali jaribu tena.',
  'error.network': 'Haiwezi kufikia seva. Angalia mtandao wako.',
};

const fr: Partial<Catalogue> = {
  'nav.overview': 'Aperçu',
  'nav.documents': 'Documents',
  'nav.batches': 'Lots',
  'nav.review': 'Vérification',
  'nav.exports': 'Exports',
  'nav.projects': 'Projets',
  'nav.templates': 'Modèles',
  'nav.connectors': 'Connecteurs',
  'nav.devices': 'Appareils',
  'nav.settings': 'Paramètres',
  'nav.configure': 'Configurer',
  'settings.language': 'Langue',
  'settings.languageHint':
    "Langue de l'interface. Les traductions manquantes reviennent à l'anglais.",
  'app.tagline': 'Capturez des documents. Obtenez des données propres.',
  'action.cancel': 'Annuler',
  'action.continue': 'Continuer',
  'action.retry': 'Réessayer',
  'action.save': 'Enregistrer',
  'action.close': 'Fermer',
  'action.export': 'Exporter',
  'action.approve': 'Approuver',
  'action.reject': 'Rejeter',
  'action.signIn': 'Se connecter',
  'action.signOut': 'Se déconnecter',
  'pairing.title': 'Associer un appareil',
  'pairing.instructions': "Ouvrez l'application IDCP sur votre téléphone et scannez ce code.",
  'pairing.expiresIn': 'Expire dans {seconds}s',
  'pairing.expired': 'Ce code a expiré. Générez-en un nouveau.',
  'pairing.success': 'Appareil associé.',
  'capture.title': 'Capturer un document',
  'capture.guide': 'Placez la page dans le cadre',
  'capture.takePhoto': 'Prendre une photo',
  'capture.uploading': 'Envoi…',
  'queue.title': 'Envois',
  'queue.offline': 'Vous êtes hors ligne. Les captures sont enregistrées sur cet appareil.',
  'review.title': 'Vérification',
  'review.needsReview': 'À vérifier',
  'review.approved': 'Enregistrement approuvé.',
  'export.title': 'Export',
  'auth.email': 'E-mail',
  'auth.password': 'Mot de passe',
  'error.generic': 'Une erreur est survenue. Veuillez réessayer.',
  'error.network': 'Serveur injoignable. Vérifiez votre connexion.',
};

const CATALOGUES: Record<Locale, Partial<Catalogue>> = { en, sw, fr };

export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * Create a translator for a locale. Missing keys fall back to English, then to the key itself,
 * so a partial translation never crashes a screen.
 */
export function createTranslator(locale: Locale = 'en'): Translate {
  const catalogue = CATALOGUES[locale] ?? {};
  return (key, params) => {
    const template = catalogue[key] ?? en[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    );
  };
}

/** Percentage of English keys covered by a locale — used by the i18n completeness test. */
export function translationCoverage(locale: Locale): number {
  const keys = Object.keys(en) as TranslationKey[];
  const translated = keys.filter((key) => CATALOGUES[locale]?.[key] !== undefined).length;
  return translated / keys.length;
}

export const enCatalogue: Catalogue = en;
