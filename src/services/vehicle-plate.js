export const normalizeVehiclePlate = (value) => {
  const compact = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.replace(/^([A-Z]{3})(\d{3})([A-Z]{2})$/, '$1-$2$3');
};

export const isValidVehiclePlate = (value) =>
  /^[A-Z]{3}-\d{3}[A-Z]{2}$/.test(normalizeVehiclePlate(value));
