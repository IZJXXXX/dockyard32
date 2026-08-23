#include <stddef.h>

int _close(int file)
{
    (void)file;
    return -1;
}

int _lseek(int file, int offset, int origin)
{
    (void)file;
    (void)offset;
    (void)origin;
    return 0;
}

int _read(int file, char *buffer, int length)
{
    (void)file;
    (void)buffer;
    (void)length;
    return 0;
}

int _write(int file, const char *buffer, int length)
{
    (void)file;
    (void)buffer;
    return length;
}
