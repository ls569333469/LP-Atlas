const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Public keys include off-curve PDAs. This validates encoding, not account ownership. */
function validateBase58(value: string, size: 32 | 64): string {
	if (!value || value.length > (size === 32 ? 44 : 88)) throw new Error("Invalid Base58 length");
	let decoded = 0n;
	for (const char of value) {
		const index = ALPHABET.indexOf(char);
		if (index < 0) throw new Error("Invalid Base58 alphabet");
		decoded = decoded * 58n + BigInt(index);
	}
	let leading = 0;
	while (value[leading] === "1") leading++;
	let bytes = 0;
	for (let n = decoded; n > 0n; n >>= 8n) bytes++;
	if (leading + bytes !== size) throw new Error(`Expected ${size} decoded bytes`);
	// Re-encoding checks canonical spelling and preserves case.
	let encoded = "";
	for (let n = decoded; n > 0n; n /= 58n) encoded = ALPHABET[Number(n % 58n)] + encoded;
	if ("1".repeat(leading) + encoded !== value) throw new Error("Noncanonical Base58");
	return value;
}
export const solanaPublicKey = (value: string): string => validateBase58(value, 32);
export const solanaSignature = (value: string): string => validateBase58(value, 64);
