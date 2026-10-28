import { ConfigScenePage } from './ConfigScenePage.tsx';
import { SecretsPanel } from './SecretsPanel.tsx';

export function ModelKeyPage() {
  return <ConfigScenePage scene="model" below={<SecretsPanel />} />;
}
