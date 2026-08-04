import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.roleplay.vault',
  appName: 'Roleplay Vault',
  webDir: 'dist',
  plugins: {
    GoogleAuth: {
      scopes: ['email', 'profile', 'https://www.googleapis.com/auth/drive.appdata'],
      clientId: '1037717798765-jscjfdk82phc7sju9jkq53157mik4deg.apps.googleusercontent.com',
      androidClientId: '1037717798765-tfjlomgaaevedv8f7grs702mg5nthe42.apps.googleusercontent.com',
      serverClientId: '1037717798765-jscjfdk82phc7sju9jkq53157mik4deg.apps.googleusercontent.com',
    },
  },
};

export default config;
