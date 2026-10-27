import { Alert, Button } from 'antd';

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message={message}
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
      style={{ margin: '24px 0' }}
    />
  );
}
