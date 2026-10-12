/** How an answer reads to the model. Multi-select answers mark only the typed ("Other") entries as custom. */
export function formatAnswer(
	answer: { answer: string | string[]; wasCustom: boolean; question?: string },
	question: { options?: Array<{ label: string }> },
): string {
	if (!Array.isArray(answer.answer)) return answer.wasCustom ? `(custom) ${answer.answer}` : answer.answer;
	const labels = new Set((question.options ?? []).map((option) => option.label));
	return answer.answer.map((value) => (labels.has(value) ? value : `(custom) ${value}`)).join("; ");
}
