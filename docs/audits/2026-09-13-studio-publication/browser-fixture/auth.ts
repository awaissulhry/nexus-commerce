export const usePermission = () => new URLSearchParams(location.search).get('scenario') !== 'permission'
