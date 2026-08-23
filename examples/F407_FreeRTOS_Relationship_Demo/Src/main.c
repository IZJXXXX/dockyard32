#include <stdint.h>

#include "FreeRTOS.h"
#include "queue.h"
#include "semphr.h"
#include "task.h"

QueueHandle_t gSensorQueue;
SemaphoreHandle_t gSharedStateMutex;
SemaphoreHandle_t gOwnerRelease;
SemaphoreHandle_t gLogSemaphore;

TaskHandle_t gProducerTask;
TaskHandle_t gConsumerTask;
TaskHandle_t gResourceOwnerTask;
TaskHandle_t gMutexWaiterTask;
TaskHandle_t gLoggerTask;

volatile uint32_t gLastSensorValue;
volatile uint32_t gLogWakeCount;

static void producerTask(void *argument)
{
    uint32_t sample = 1000;
    (void)argument;

    for (;;)
    {
        (void)xQueueSend(gSensorQueue, &sample, portMAX_DELAY);
        sample++;
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

static void consumerTask(void *argument)
{
    uint32_t sample;
    (void)argument;

    for (;;)
    {
        if (xQueueReceive(gSensorQueue, &sample, portMAX_DELAY) == pdPASS)
        {
            gLastSensorValue = sample;
        }
    }
}

static void resourceOwnerTask(void *argument)
{
    (void)argument;
    (void)xSemaphoreTake(gSharedStateMutex, portMAX_DELAY);

    /*
     * Deliberate demonstration state: this task owns SharedStateMutex while it
     * waits for OwnerRelease.  It makes the holder/waiter relationship stable
     * enough for a debugger to inspect.  Do not copy this pattern into a real
     * application because blocking while holding a mutex can cause deadlocks.
     */
    (void)xSemaphoreTake(gOwnerRelease, portMAX_DELAY);
    xSemaphoreGive(gSharedStateMutex);
    vTaskDelete(NULL);
}

static void mutexWaiterTask(void *argument)
{
    (void)argument;

    for (;;)
    {
        (void)xSemaphoreTake(gSharedStateMutex, portMAX_DELAY);
        xSemaphoreGive(gSharedStateMutex);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

static void loggerTask(void *argument)
{
    (void)argument;

    for (;;)
    {
        (void)xSemaphoreTake(gLogSemaphore, portMAX_DELAY);
        gLogWakeCount++;
    }
}

static void createKernelObjects(void)
{
    gSensorQueue = xQueueCreate(4, sizeof(uint32_t));
    gSharedStateMutex = xSemaphoreCreateMutex();
    gOwnerRelease = xSemaphoreCreateBinary();
    gLogSemaphore = xSemaphoreCreateCounting(8, 0);

    configASSERT(gSensorQueue != NULL);
    configASSERT(gSharedStateMutex != NULL);
    configASSERT(gOwnerRelease != NULL);
    configASSERT(gLogSemaphore != NULL);

    vQueueAddToRegistry(gSensorQueue, "SensorQueue");
    vQueueAddToRegistry(gSharedStateMutex, "SharedStateMutex");
    vQueueAddToRegistry(gOwnerRelease, "OwnerRelease");
    vQueueAddToRegistry(gLogSemaphore, "LogSemaphore");
}

int main(void)
{
    SystemCoreClockUpdate();
    createKernelObjects();

    configASSERT(xTaskCreate(producerTask, "Producer", 256, NULL, 1, &gProducerTask) == pdPASS);
    configASSERT(xTaskCreate(consumerTask, "Consumer", 256, NULL, 3, &gConsumerTask) == pdPASS);
    configASSERT(xTaskCreate(resourceOwnerTask, "ResourceOwner", 256, NULL, 4, &gResourceOwnerTask) == pdPASS);
    configASSERT(xTaskCreate(mutexWaiterTask, "MutexWaiter", 256, NULL, 3, &gMutexWaiterTask) == pdPASS);
    configASSERT(xTaskCreate(loggerTask, "Logger", 256, NULL, 2, &gLoggerTask) == pdPASS);

    vTaskStartScheduler();
    for (;;) {}
}

void vApplicationMallocFailedHook(void)
{
    taskDISABLE_INTERRUPTS();
    for (;;) {}
}

void vApplicationStackOverflowHook(TaskHandle_t task, char *taskName)
{
    (void)task;
    (void)taskName;
    taskDISABLE_INTERRUPTS();
    for (;;) {}
}
