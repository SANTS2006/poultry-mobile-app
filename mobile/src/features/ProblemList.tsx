import { Card, Text } from '../ui/components';

/** Confirmation shown after saving: says plainly whether the record is on the server yet or only safely stored on this phone. */
export function ProblemList({ problems, error }: { problems: string[]; error?: string | null }) {
  if (!problems.length && !error) return null;
  return (
    <Card tone="danger">
      <Text bold>Please fix this first</Text>
      {problems.map((p) => <Text key={p}>• {p}</Text>)}
      {error ? <Text>{error}</Text> : null}
    </Card>
  );
}
