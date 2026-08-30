cmake_minimum_required(VERSION 3.20)

set(CMAKE_TOOLCHAIN_FILE "${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

project(F407_FreeRTOS_Relationship_Demo LANGUAGES C ASM)

set(TARGET ${PROJECT_NAME})
set(CMSIS_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/ThirdParty/STM32CubeF4/Drivers/CMSIS)
set(FREERTOS_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/ThirdParty/FreeRTOS-Kernel)

add_executable(${TARGET}
  Src/main.c
  Src/syscalls.c
  ${CMSIS_ROOT}/Device/ST/STM32F4xx/Source/Templates/system_stm32f4xx.c
  ${CMSIS_ROOT}/Device/ST/STM32F4xx/Source/Templates/gcc/startup_stm32f407xx.s
  ${FREERTOS_ROOT}/tasks.c
  ${FREERTOS_ROOT}/queue.c
  ${FREERTOS_ROOT}/list.c
  ${FREERTOS_ROOT}/timers.c
  ${FREERTOS_ROOT}/event_groups.c
  ${FREERTOS_ROOT}/stream_buffer.c
  ${FREERTOS_ROOT}/portable/GCC/ARM_CM4F/port.c
  ${FREERTOS_ROOT}/portable/MemMang/heap_4.c
)

target_include_directories(${TARGET} PRIVATE
  Inc
  ${CMSIS_ROOT}/Include
  ${CMSIS_ROOT}/Device/ST/STM32F4xx/Include
  ${FREERTOS_ROOT}/include
  ${FREERTOS_ROOT}/portable/GCC/ARM_CM4F
)

target_compile_definitions(${TARGET} PRIVATE STM32F407xx)

set(CPU_FLAGS
  -mcpu=cortex-m4
  -mthumb
  -mfpu=fpv4-sp-d16
  -mfloat-abi=hard
)

target_compile_options(${TARGET} PRIVATE
  ${CPU_FLAGS}
  -ffunction-sections
  -fdata-sections
  -fstack-usage
  -Wall
  -Wextra
  $<$<CONFIG:Debug>:-Og;-g3;-ggdb>
  $<$<CONFIG:Release>:-Os>
)

target_link_options(${TARGET} PRIVATE
  ${CPU_FLAGS}
  --specs=nano.specs
  --specs=nosys.specs
  -T${CMAKE_CURRENT_SOURCE_DIR}/stm32f407xg_flash.ld
  -Wl,--gc-sections
  -Wl,-Map=${CMAKE_CURRENT_BINARY_DIR}/${TARGET}.map
  -Wl,--print-memory-usage
)

target_link_libraries(${TARGET} PRIVATE m)
set_target_properties(${TARGET} PROPERTIES SUFFIX ".elf")

add_custom_command(TARGET ${TARGET} POST_BUILD
  COMMAND ${CMAKE_OBJCOPY} -O ihex
          $<TARGET_FILE:${TARGET}>
          ${CMAKE_CURRENT_BINARY_DIR}/${TARGET}.hex
  COMMAND ${CMAKE_SIZE} $<TARGET_FILE:${TARGET}>
  COMMENT "Creating HEX and reporting firmware size"
)
